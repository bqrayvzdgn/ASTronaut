using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Diagnostics;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.MinimalApi;

// Discovers ASP.NET Core Minimal API endpoints — `app.MapGet/Post/Put/Delete/Patch`
// invocations rooted on a WebApplication / IEndpointRouteBuilder / RouteGroupBuilder.
//
// MVP scope:
//   - Literal-path Map* with primitive or DTO parameters.
//   - MapGroup (single + nested) — path prefixes concat across the chain.
//   - Fluent chain methods: WithName, WithTags (collected after the Map* call).
//   - Handler forms: lambda (paren + simple), method group reference.
//
// Deferred (Iter E+):
//   - Endpoint filters (.AddEndpointFilter), .RequireAuthorization, .WithOpenApi.
//   - TypedResults return inspection.
//   - WithMetadata, AllowAnonymous, RequireCors, etc.
public sealed class MinimalApiWalker
{
    private static readonly Dictionary<string, string> MapToVerb = new()
    {
        ["MapGet"] = "GET",
        ["MapPost"] = "POST",
        ["MapPut"] = "PUT",
        ["MapDelete"] = "DELETE",
        ["MapPatch"] = "PATCH",
    };

    private readonly Compilation _compilation;
    private readonly string _repoRoot;
    private readonly SchemaContext _schemaContext;
    private readonly List<RouteInfo> _routes = new();
    private readonly List<ParseError> _errors = new();
    private readonly bool _stringEnums;
    private readonly Dictionary<ISymbol, string> _groupPrefixes =
        new(SymbolEqualityComparer.Default);
    // Groups (by their local-variable symbol) that carry a group-level
    // `.RequireAuthorization()` — propagated to every endpoint mapped under them.
    private readonly Dictionary<ISymbol, bool> _groupAuth =
        new(SymbolEqualityComparer.Default);

    public MinimalApiWalker(Compilation compilation, string repoRoot, SchemaContext schemaContext)
    {
        _compilation = compilation;
        _repoRoot = repoRoot;
        _schemaContext = schemaContext;
        _stringEnums = EnumConfig.UsesStringEnumsByDefault(compilation);
    }

    public IReadOnlyList<RouteInfo> Routes => _routes;
    public IReadOnlyList<ParseError> Errors => _errors;

    public void Walk()
    {
        // Two-pass: first resolve all MapGroup variable assignments, then walk
        // the Map* invocations now that prefixes can be looked up.
        foreach (var tree in _compilation.SyntaxTrees)
        {
            var model = _compilation.GetSemanticModel(tree);
            CollectGroupPrefixes(tree.GetRoot(), model);
        }
        foreach (var tree in _compilation.SyntaxTrees)
        {
            var model = _compilation.GetSemanticModel(tree);
            CollectMapInvocations(tree.GetRoot(), model);
        }
    }

    private void CollectGroupPrefixes(SyntaxNode root, SemanticModel model)
    {
        foreach (var local in root.DescendantNodes().OfType<LocalDeclarationStatementSyntax>())
        {
            foreach (var decl in local.Declaration.Variables)
            {
                // The initializer evaluates to the group builder; it may carry a
                // fluent chain (e.g. `app.MapGroup("/api").RequireAuthorization()`),
                // so resolve prefix + group-auth off the whole expression.
                if (decl.Initializer?.Value is not ExpressionSyntax init) continue;
                if (!ChainContainsMapGroup(init)) continue;

                var (prefix, requiresAuth) = ResolveChainContext(init, model);
                if (prefix is null) continue;

                if (model.GetDeclaredSymbol(decl) is ILocalSymbol sym)
                {
                    _groupPrefixes[sym] = prefix;
                    if (requiresAuth) _groupAuth[sym] = true;
                }
            }
        }
    }

    private static bool ChainContainsMapGroup(ExpressionSyntax expr)
    {
        var current = expr;
        while (current is InvocationExpressionSyntax inv)
        {
            if (GetInvokedMethodName(inv) == "MapGroup") return true;
            current = inv.Expression is MemberAccessExpressionSyntax mae ? mae.Expression : null!;
            if (current is null) break;
        }
        return false;
    }

    private void CollectMapInvocations(SyntaxNode root, SemanticModel model)
    {
        foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var methodName = GetInvokedMethodName(inv);
            if (methodName is null) continue;

            // MapGet/MapPost/MapPut/MapDelete/MapPatch — single verb, handler at [1].
            if (MapToVerb.TryGetValue(methodName, out var verb))
            {
                if (inv.ArgumentList.Arguments.Count < 2) continue;
                if (!IsRoutingExtension(inv, model)) continue;
                EmitRoutes(inv, model, new[] { verb },
                    inv.ArgumentList.Arguments[1].Expression, methodName);
                continue;
            }

            // MapMethods(pattern, new[]{"GET","POST"}, handler) — one route per verb.
            if (methodName == "MapMethods")
            {
                if (inv.ArgumentList.Arguments.Count < 3) continue;
                if (!IsRoutingExtension(inv, model)) continue;

                var verbs = ReadHttpMethods(inv.ArgumentList.Arguments[1].Expression, model);
                if (verbs is null)
                {
                    AddDiagnostic(inv, DiagnosticCodes.DynamicRoutePath,
                        "MapMethods with a non-literal HTTP-methods collection was skipped "
                        + "(only inline string-literal method lists are supported).");
                    continue;
                }
                EmitRoutes(inv, model, verbs,
                    inv.ArgumentList.Arguments[2].Expression, methodName);
                continue;
            }

            // Verb-less Map(pattern, handler). Only the endpoint-routing overload
            // (not the IApplicationBuilder middleware-branching Map) is a route.
            if (methodName == "Map")
            {
                if (inv.ArgumentList.Arguments.Count < 2) continue;
                if (!IsRoutingExtension(inv, model)) continue;
                if (!IsEndpointMapInvocation(inv, model)) continue;
                // No verb is specified for the verb-less Map (it matches all
                // methods at runtime); GET is emitted as the representative verb.
                EmitRoutes(inv, model, new[] { "GET" },
                    inv.ArgumentList.Arguments[1].Expression, methodName);
                continue;
            }
        }
    }

    // Resolves the route pattern/prefix/group-auth once, then emits one RouteInfo
    // per verb (MapMethods yields several; the others exactly one).
    private void EmitRoutes(
        InvocationExpressionSyntax inv,
        SemanticModel model,
        IReadOnlyList<string> verbs,
        ExpressionSyntax handler,
        string methodNameForDiag)
    {
        var pattern = GetStringLiteral(inv.ArgumentList.Arguments[0].Expression);
        if (pattern is null)
        {
            AddDiagnostic(inv, DiagnosticCodes.DynamicRoutePath,
                $"{methodNameForDiag} with a non-literal route path was skipped "
                + "(only string-literal paths are supported).");
            return;
        }

        var (prefix, groupRequiresAuth) = ResolveReceiverContext(inv, model);
        var combined = CombinePath(prefix, pattern);
        var parsed = RouteTemplateParser.Parse(combined);

        foreach (var verb in verbs)
        {
            var route = BuildRoute(inv, verb, parsed, handler, model, groupRequiresAuth);
            if (route is not null) _routes.Add(route);
        }
    }

    // Reads a statically-resolvable collection of HTTP-method literals, e.g.
    // `new[] { "GET", "POST" }`, `new string[] { ... }`, `new List<string> { ... }`,
    // or a C# 12 collection expression `["GET", "POST"]`. Verbs are uppercased and
    // de-duplicated. Returns null when the collection is not statically resolvable.
    private static IReadOnlyList<string>? ReadHttpMethods(ExpressionSyntax expr, SemanticModel model)
    {
        InitializerExpressionSyntax? initializer = expr switch
        {
            ImplicitArrayCreationExpressionSyntax a => a.Initializer,
            ArrayCreationExpressionSyntax a => a.Initializer,
            ObjectCreationExpressionSyntax o => o.Initializer,
            _ => null,
        };

        var verbs = new List<string>();
        if (initializer is not null)
        {
            foreach (var e in initializer.Expressions)
            {
                if (model.GetConstantValue(e) is not { HasValue: true, Value: string s }) return null;
                AddVerb(verbs, s);
            }
            return verbs.Count > 0 ? verbs : null;
        }

        if (expr is CollectionExpressionSyntax col)
        {
            foreach (var element in col.Elements)
            {
                if (element is not ExpressionElementSyntax ee) return null;
                if (model.GetConstantValue(ee.Expression) is not { HasValue: true, Value: string s }) return null;
                AddVerb(verbs, s);
            }
            return verbs.Count > 0 ? verbs : null;
        }

        return null;

        static void AddVerb(List<string> acc, string raw)
        {
            var v = raw.ToUpperInvariant();
            if (!acc.Contains(v)) acc.Add(v);
        }
    }

    // Distinguishes the endpoint-routing `Map` (EndpointRouteBuilderExtensions.Map,
    // returns RouteHandlerBuilder) from the IApplicationBuilder middleware-branching
    // `Map`. When the symbol can't be resolved, fall back to the shape of the
    // handler argument: the middleware overload takes an Action<IApplicationBuilder>.
    private static bool IsEndpointMapInvocation(InvocationExpressionSyntax inv, SemanticModel model)
    {
        var info = model.GetSymbolInfo(inv);
        var sym = info.Symbol as IMethodSymbol
                  ?? info.CandidateSymbols.OfType<IMethodSymbol>().FirstOrDefault();
        if (sym is not null)
        {
            var containing = sym.ContainingType?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            return containing == "global::Microsoft.AspNetCore.Builder.EndpointRouteBuilderExtensions";
        }

        // Unresolved: treat as an endpoint unless the handler is clearly a
        // middleware branch (a lambda whose parameter is an IApplicationBuilder).
        var handler = inv.ArgumentList.Arguments[1].Expression;
        if (handler is SimpleLambdaExpressionSyntax simple
            && IsApplicationBuilderParam(simple.Parameter, model))
        {
            return false;
        }
        if (handler is ParenthesizedLambdaExpressionSyntax paren
            && paren.ParameterList.Parameters.Count == 1
            && IsApplicationBuilderParam(paren.ParameterList.Parameters[0], model))
        {
            return false;
        }
        return true;
    }

    private static bool IsApplicationBuilderParam(ParameterSyntax parameter, SemanticModel model)
    {
        if (parameter.Type is null) return false;
        var type = model.GetTypeInfo(parameter.Type).Type;
        return type is not null && InheritsOrImplements(type,
            "global::Microsoft.AspNetCore.Builder.IApplicationBuilder");
    }

    // Resolves the group prefix and group-level auth contributed by the receiver
    // chain of a Map* / MapGroup invocation (the value the call is invoked on).
    private (string? Prefix, bool RequiresAuth) ResolveReceiverContext(
        InvocationExpressionSyntax inv, SemanticModel model)
    {
        if (inv.Expression is not MemberAccessExpressionSyntax mae) return (null, false);
        return ResolveChainContext(mae.Expression, model);
    }

    // Resolves (prefix, requiresAuth) for an expression that evaluates to an
    // IEndpointRouteBuilder. Handles:
    //   - a local variable referencing a MapGroup(...) result (with inherited auth),
    //   - inline chains: `app.MapGroup("/a").RequireAuthorization().MapGroup("/b")`,
    //   - `.AllowAnonymous()` on a group clears the inherited requirement.
    // Non-group receivers (the root WebApplication/app) resolve to (null, false).
    private (string? Prefix, bool RequiresAuth) ResolveChainContext(
        ExpressionSyntax expr, SemanticModel model)
    {
        // Local variable — look up what CollectGroupPrefixes recorded.
        if (expr is IdentifierNameSyntax id)
        {
            var sym = model.GetSymbolInfo(id).Symbol;
            if (sym is null) return (null, false);
            _groupPrefixes.TryGetValue(sym, out var p);
            _groupAuth.TryGetValue(sym, out var a);
            return (p, a);
        }

        if (expr is InvocationExpressionSyntax inv)
        {
            var name = GetInvokedMethodName(inv);
            if (name == "MapGroup")
            {
                var pattern = inv.ArgumentList.Arguments.Count > 0
                    ? GetStringLiteral(inv.ArgumentList.Arguments[0].Expression)
                    : null;
                var (parentPrefix, parentAuth) = ResolveReceiverContext(inv, model);
                var prefix = pattern is null ? parentPrefix : CombinePath(parentPrefix, pattern);
                return (prefix, parentAuth);
            }

            // A fluent call wrapping an inner receiver (RequireAuthorization,
            // AllowAnonymous, WithTags, ...). Recurse into the receiver, then apply
            // this call's effect on the group-auth flag.
            if (inv.Expression is MemberAccessExpressionSyntax innerMae)
            {
                var (prefix, auth) = ResolveChainContext(innerMae.Expression, model);
                if (name == "RequireAuthorization") auth = true;
                else if (name == "AllowAnonymous") auth = false;
                return (prefix, auth);
            }
        }

        return (null, false);
    }

    private static string CombinePath(string? prefix, string pattern)
    {
        if (string.IsNullOrEmpty(prefix)) return pattern;
        var left = prefix.TrimEnd('/');
        var right = pattern.StartsWith('/') ? pattern : "/" + pattern;
        return left + right;
    }

    // Confirms the invocation is on a routing-extension target type
    // (WebApplication, IEndpointRouteBuilder, RouteGroupBuilder).
    private static bool IsRoutingExtension(InvocationExpressionSyntax inv, SemanticModel model)
    {
        if (inv.Expression is not MemberAccessExpressionSyntax mae) return false;
        var receiverType = model.GetTypeInfo(mae.Expression).Type;
        if (receiverType is null) return false;
        return InheritsOrImplements(receiverType,
            "global::Microsoft.AspNetCore.Routing.IEndpointRouteBuilder")
            || ExactlyIs(receiverType, "global::Microsoft.AspNetCore.Routing.RouteGroupBuilder")
            || ExactlyIs(receiverType, "global::Microsoft.AspNetCore.Builder.WebApplication");
    }

    private static bool InheritsOrImplements(ITypeSymbol type, string fullName)
    {
        if (ExactlyIs(type, fullName)) return true;
        foreach (var iface in type.AllInterfaces)
        {
            if (ExactlyIs(iface, fullName)) return true;
        }
        for (var t = type.BaseType; t is not null; t = t.BaseType)
        {
            if (ExactlyIs(t, fullName)) return true;
        }
        return false;
    }

    private static bool ExactlyIs(ITypeSymbol type, string fullName) =>
        type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == fullName;

    private static string? GetInvokedMethodName(InvocationExpressionSyntax inv)
    {
        return inv.Expression switch
        {
            MemberAccessExpressionSyntax mae => mae.Name.Identifier.ValueText,
            IdentifierNameSyntax id => id.Identifier.ValueText,
            _ => null,
        };
    }

    private static string? GetStringLiteral(ExpressionSyntax expr)
    {
        if (expr is LiteralExpressionSyntax lit && lit.Token.Value is string s) return s;
        return null;
    }

    private RouteInfo? BuildRoute(
        InvocationExpressionSyntax mapInvocation,
        string verb,
        RouteTemplateParser.Result parsed,
        ExpressionSyntax handler,
        SemanticModel model,
        bool groupRequiresAuth = false)
    {
        var pathParamNames = new HashSet<string>(
            parsed.PathParams.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);

        var pathParams = new List<ParamInfo>(parsed.PathParams);
        var queryParams = new List<ParamInfo>();
        var headerParams = new List<ParamInfo>();
        BodyInfo? body = null;

        var typeMapper = new TypeToSchema(_schemaContext, _stringEnums);
        var handlerParams = ExtractHandlerParameters(handler, model);
        ITypeSymbol? returnType = ExtractHandlerReturnType(handler, model);

        foreach (var hp in handlerParams)
        {
            var binding = hp.AttributeBinding ?? ResolveDefaultBinding(hp, pathParamNames);
            var schema = typeMapper.Map(hp.Type);
            var paramInfo = new ParamInfo
            {
                Name = hp.Name,
                Schema = schema,
                Required = hp.Required,
            };
            switch (binding)
            {
                case Binding.Path:
                    UpsertPathParam(pathParams, paramInfo);
                    break;
                case Binding.Query:
                    // A complex [FromQuery] object binds each of its properties as
                    // its own query parameter — flatten it (mirrors ControllerWalker).
                    AddQueryParams(queryParams, hp.Type, paramInfo);
                    break;
                case Binding.Header:
                    headerParams.Add(paramInfo);
                    break;
                case Binding.AsParameters:
                    // [AsParameters] T is not a body: expand T's bindable properties
                    // into path params (name matches a route token) or query params.
                    ExpandAsParameters(schema, pathParamNames, pathParams, queryParams);
                    break;
                case Binding.Body:
                    body = new BodyInfo
                    {
                        ContentType = TypeClassifier.IsFormFileType(hp.Type) ? "multipart/form-data" : "application/json",
                        Schema = schema,
                        Required = hp.Required,
                    };
                    break;
                case Binding.Service:
                    // DI-injected service — not a route param.
                    break;
            }
        }

        var route = new RouteInfo
        {
            Method = verb,
            Path = parsed.NormalizedPath,
            Source = MakeSourceLocation(mapInvocation),
        };
        if (pathParams.Count > 0) route = route with { PathParams = pathParams };
        if (queryParams.Count > 0) route = route with { QueryParams = queryParams };
        if (headerParams.Count > 0) route = route with { HeaderParams = headerParams };
        if (body is not null) route = route with { RequestBody = body };

        // For method-reference handlers, pull XML doc, [ProducesResponseType],
        // and [Authorize] from the referenced method (lambdas don't carry these).
        var isMethodReference = handler is not LambdaExpressionSyntax;
        var handlerMethod = isMethodReference
            ? ResolveMethodGroup(handler, model)
            : null;
        if (isMethodReference && handlerMethod is null)
        {
            AddDiagnostic(mapInvocation, DiagnosticCodes.UnresolvedHandler,
                $"Handler for {verb} {parsed.NormalizedPath} could not be resolved; "
                + "its parameters and responses may be incomplete.");
        }

        var declaredResponses = handlerMethod is not null
            ? ResponseTypeReader.Read(handlerMethod, typeMapper)
            : new List<ResponseInfo>();
        var responses = declaredResponses.Count > 0
            ? declaredResponses
            // 1) TypedResults return type (Results<Ok<T>, NotFound>, Ok<T>, ...);
            // 2) Results.Ok(dto)/TypedResults.* calls in the handler body;
            // 3) plain return-type inference.
            : TypedResultsReader.TryRead(returnType, typeMapper)
              ?? MinimalApiResultReader.TryRead(handler, handlerMethod, model, _compilation, typeMapper)
              ?? BuildResponses(returnType, typeMapper, verb);
        route = route with { Responses = responses };

        if (handlerMethod is not null)
        {
            var docs = XmlDocReader.From(handlerMethod);
            if (docs.Summary is not null) route = route with { Summary = docs.Summary };
            if (docs.Description is not null) route = route with { Description = docs.Description };

            var auth = AuthReader.Resolve(handlerMethod, handlerMethod.ContainingType);
            if (auth is not null) route = route with { Auth = auth };
        }

        // Apply fluent chain (WithName, WithTags, RequireAuthorization, ...).
        // A group-level RequireAuthorization is folded in as an auth baseline that
        // a leaf .AllowAnonymous() can still override.
        route = ApplyFluentChain(mapInvocation, model, route, typeMapper, groupRequiresAuth);
        return route;
    }

    private enum Binding { Path, Query, Header, Body, Service, AsParameters }

    // Binding is `null` when there's no explicit [FromX] attribute — caller resolves
    // the default after also checking whether the name matches a path template token.
    private sealed record HandlerParam(string Name, ITypeSymbol Type, bool Required, Binding? AttributeBinding);

    private static IReadOnlyList<HandlerParam> ExtractHandlerParameters(
        ExpressionSyntax handler, SemanticModel model)
    {
        switch (handler)
        {
            case ParenthesizedLambdaExpressionSyntax paren:
                return paren.ParameterList.Parameters
                    .Select(p => MakeHandlerParam(p, model))
                    .Where(p => p is not null)
                    .Select(p => p!)
                    .ToList();
            case SimpleLambdaExpressionSyntax simple:
                var hp = MakeHandlerParam(simple.Parameter, model);
                return hp is null ? Array.Empty<HandlerParam>() : new[] { hp };
            default:
                // Method group / method reference: resolve target IMethodSymbol.
                var sym = ResolveMethodGroup(handler, model);
                if (sym is null) return Array.Empty<HandlerParam>();
                return sym.Parameters.Select(p => MakeHandlerParamFromSymbol(p)).ToList();
        }
    }

    // Roslyn returns SymbolInfo.Symbol == null for unresolved method groups
    // (the conversion target is `Delegate`, so no specific overload binds).
    // Pull the first candidate instead — for Minimal API handlers there is
    // typically one unambiguous static method.
    private static IMethodSymbol? ResolveMethodGroup(ExpressionSyntax handler, SemanticModel model)
    {
        var info = model.GetSymbolInfo(handler);
        if (info.Symbol is IMethodSymbol resolved) return resolved;
        foreach (var candidate in info.CandidateSymbols)
        {
            if (candidate is IMethodSymbol cm) return cm;
        }
        return null;
    }

    private static HandlerParam? MakeHandlerParam(ParameterSyntax syntax, SemanticModel model)
    {
        if (syntax.Type is null) return null;
        var type = model.GetTypeInfo(syntax.Type).Type;
        if (type is null) return null;

        var attrBinding = ResolveBindingFromAttributes(syntax.AttributeLists);
        var required = syntax.Default is null && !TypeClassifier.IsNullable(type);
        return new HandlerParam(syntax.Identifier.ValueText, type, required, attrBinding);
    }

    private static HandlerParam MakeHandlerParamFromSymbol(IParameterSymbol p)
    {
        var attrBinding = ResolveBindingFromSymbolAttributes(p);
        var required = !p.IsOptional && !TypeClassifier.IsNullable(p.Type);
        return new HandlerParam(p.Name, p.Type, required, attrBinding);
    }

    private static Binding? ResolveBindingFromAttributes(SyntaxList<AttributeListSyntax> lists)
    {
        foreach (var list in lists)
        {
            foreach (var attr in list.Attributes)
            {
                var name = attr.Name.ToString();
                if (Matches(name, "AsParameters")) return Binding.AsParameters;
                if (Matches(name, "FromBody")) return Binding.Body;
                if (Matches(name, "FromRoute")) return Binding.Path;
                if (Matches(name, "FromQuery")) return Binding.Query;
                if (Matches(name, "FromHeader")) return Binding.Header;
                if (Matches(name, "FromServices") || Matches(name, "FromKeyedServices"))
                    return Binding.Service;
            }
        }
        return null;
    }

    private static Binding? ResolveBindingFromSymbolAttributes(IParameterSymbol p)
    {
        foreach (var attr in p.GetAttributes())
        {
            var name = attr.AttributeClass?.Name ?? "";
            if (name is "AsParametersAttribute" or "AsParameters") return Binding.AsParameters;
            if (name is "FromBodyAttribute" or "FromBody") return Binding.Body;
            if (name is "FromRouteAttribute" or "FromRoute") return Binding.Path;
            if (name is "FromQueryAttribute" or "FromQuery") return Binding.Query;
            if (name is "FromHeaderAttribute" or "FromHeader") return Binding.Header;
            if (name is "FromServicesAttribute" or "FromServices"
                or "FromKeyedServicesAttribute" or "FromKeyedServices") return Binding.Service;
        }
        return null;
    }

    private static Binding DefaultBindingForType(ITypeSymbol type)
    {
        if (TypeClassifier.IsServiceType(type)) return Binding.Service;
        if (TypeClassifier.IsSimpleType(type)) return Binding.Query;
        return Binding.Body;
    }

    private static Binding ResolveDefaultBinding(HandlerParam hp, HashSet<string> pathParamNames)
    {
        if (pathParamNames.Contains(hp.Name)) return Binding.Path;
        return DefaultBindingForType(hp.Type);
    }

    private static bool Matches(string syntaxName, string attrName)
    {
        // Strip namespace, strip generic args, strip "Attribute" suffix.
        var n = syntaxName;
        var lastDot = n.LastIndexOf('.');
        if (lastDot >= 0) n = n.Substring(lastDot + 1);
        var lt = n.IndexOf('<');
        if (lt >= 0) n = n.Substring(0, lt);
        if (n.EndsWith("Attribute", StringComparison.Ordinal))
            n = n.Substring(0, n.Length - 9);
        return n == attrName;
    }

    private static ITypeSymbol? ExtractHandlerReturnType(ExpressionSyntax handler, SemanticModel model)
    {
        switch (handler)
        {
            case LambdaExpressionSyntax lambda:
                // Expression-bodied lambdas: ask Roslyn for the body's type
                // directly. Minimal API overloads bind handlers to `Delegate`,
                // which has no DelegateInvokeMethod, so we can't rely on it.
                if (lambda.Body is ExpressionSyntax body)
                {
                    var bodyType = model.GetTypeInfo(body).Type
                                   ?? model.GetTypeInfo(body).ConvertedType;
                    if (bodyType is not null && bodyType.SpecialType != SpecialType.System_Void)
                    {
                        return bodyType;
                    }
                }
                // Statement-bodied: scan return statements for their expression type.
                if (lambda.Body is BlockSyntax block)
                {
                    foreach (var ret in block.DescendantNodes().OfType<ReturnStatementSyntax>())
                    {
                        if (ret.Expression is null) continue;
                        var retType = model.GetTypeInfo(ret.Expression).Type;
                        if (retType is not null) return retType;
                    }
                }
                // Final fallback: delegate invoke method when present.
                var typeInfo = model.GetTypeInfo(lambda);
                if (typeInfo.ConvertedType is INamedTypeSymbol delegateType
                    && delegateType.DelegateInvokeMethod is { } invoke)
                {
                    return invoke.ReturnType;
                }
                return null;
            default:
                var sym = model.GetSymbolInfo(handler).Symbol as IMethodSymbol;
                return sym?.ReturnType;
        }
    }

    private static void UpsertPathParam(List<ParamInfo> pathParams, ParamInfo incoming)
    {
        for (int i = 0; i < pathParams.Count; i++)
        {
            if (string.Equals(pathParams[i].Name, incoming.Name, StringComparison.OrdinalIgnoreCase))
            {
                var existing = pathParams[i];
                var merged = incoming.Schema with
                {
                    Constraints = incoming.Schema.Constraints ?? existing.Schema.Constraints,
                };
                pathParams[i] = incoming with { Name = existing.Name, Schema = merged };
                return;
            }
        }
        pathParams.Add(incoming);
    }

    // A [FromQuery] scalar is a single query parameter; a [FromQuery] complex
    // object binds each of its public properties as its own query parameter
    // (ASP.NET model binding), so flatten it. Mirrors ControllerWalker.AddQueryParams.
    private void AddQueryParams(List<ParamInfo> queryParams, ITypeSymbol type, ParamInfo paramInfo)
    {
        if (TypeClassifier.IsSimpleType(type))
        {
            queryParams.Add(paramInfo);
            return;
        }
        var obj = ResolveObjectSchema(paramInfo.Schema);
        if (obj?.Properties is null)
        {
            queryParams.Add(paramInfo);
            return;
        }
        var required = obj.RequiredProperties ?? new List<string>();
        foreach (var kvp in obj.Properties)
        {
            queryParams.Add(new ParamInfo
            {
                Name = kvp.Key,
                Schema = kvp.Value,
                Required = required.Contains(kvp.Key),
            });
        }
    }

    // [AsParameters] T binds each public property individually: properties whose
    // name matches a route token become path params, the rest become query params.
    private void ExpandAsParameters(
        Schema schema,
        HashSet<string> pathParamNames,
        List<ParamInfo> pathParams,
        List<ParamInfo> queryParams)
    {
        var obj = ResolveObjectSchema(schema);
        if (obj?.Properties is null) return;
        var required = obj.RequiredProperties ?? new List<string>();
        foreach (var kvp in obj.Properties)
        {
            var param = new ParamInfo
            {
                Name = kvp.Key,
                Schema = kvp.Value,
                Required = required.Contains(kvp.Key),
            };
            if (pathParamNames.Contains(kvp.Key))
            {
                UpsertPathParam(pathParams, param);
            }
            else
            {
                queryParams.Add(param);
            }
        }
    }

    // Resolves an object schema to inspect its properties, following a REFERENCE
    // into the hoisted shared schema when needed.
    private Schema? ResolveObjectSchema(Schema schema)
    {
        if (schema.Kind == "OBJECT") return schema;
        if (schema.Kind == "REFERENCE" && schema.RefName is not null
            && _schemaContext.SharedSchemas.TryGetValue(schema.RefName, out var target))
        {
            return target;
        }
        return null;
    }

    private static List<ResponseInfo> BuildResponses(ITypeSymbol? returnType, TypeToSchema mapper, string verb)
    {
        var unwrapped = returnType is null ? null : UnwrapReturnWrappers(returnType);
        var hasSchema = unwrapped is not null
            && !IsIResultType(unwrapped)
            && unwrapped.SpecialType != SpecialType.System_Void;

        var status = ResponseTypeReader.InferDefaultStatus(verb, hasSchema);
        var description = ResponseTypeReader.DescribeStatusPublic(status);

        var response = new ResponseInfo { Status = status, Description = description };
        if (hasSchema && unwrapped is not null)
        {
            response = response with
            {
                Schema = mapper.Map(unwrapped),
                ContentType = "application/json",
            };
        }
        return new List<ResponseInfo> { response };
    }

    private static ITypeSymbol? UnwrapReturnWrappers(ITypeSymbol type)
    {
        var current = type;
        for (int i = 0; i < 4; i++)
        {
            if (current is INamedTypeSymbol named && named.IsGenericType)
            {
                var full = named.ConstructedFrom
                    ?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
                if (full is "global::System.Threading.Tasks.Task<TResult>"
                    or "global::System.Threading.Tasks.ValueTask<TResult>"
                    or "global::Microsoft.AspNetCore.Mvc.ActionResult<TValue>")
                {
                    current = named.TypeArguments[0];
                    continue;
                }
            }
            if (current is INamedTypeSymbol bare)
            {
                var full = bare.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
                if (full is "global::System.Threading.Tasks.Task"
                    or "global::System.Threading.Tasks.ValueTask")
                {
                    return null;
                }
            }
            break;
        }
        return current;
    }

    private static bool IsIResultType(ITypeSymbol type)
    {
        var full = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return full is "global::Microsoft.AspNetCore.Http.IResult"
            or "global::Microsoft.AspNetCore.Mvc.IActionResult";
    }

    // Walks outer fluent calls chained after the Map* invocation.
    // `mapInv.Parent.Parent` is the outer InvocationExpression (`.WithName(...)`).
    private static RouteInfo ApplyFluentChain(
        InvocationExpressionSyntax mapInv, SemanticModel model, RouteInfo route,
        TypeToSchema typeMapper, bool groupRequiresAuth = false)
    {
        SyntaxNode? current = mapInv;
        var tags = new List<string>(route.Tags ?? new List<string>());
        string? name = route.OperationId;
        var allowAnonymous = false;
        var requiresAuth = false;
        var producesResponses = new Dictionary<int, Schema?>();
        BodyInfo? acceptsBody = null;

        while (current?.Parent is MemberAccessExpressionSyntax mae
               && mae.Parent is InvocationExpressionSyntax outer)
        {
            var methodName = mae.Name.Identifier.ValueText;
            switch (methodName)
            {
                case "WithName":
                    var nameArg = GetStringLiteral(outer.ArgumentList.Arguments[0].Expression);
                    if (nameArg is not null) name = nameArg;
                    break;
                case "WithTags":
                    foreach (var arg in outer.ArgumentList.Arguments)
                    {
                        var tag = GetStringLiteral(arg.Expression);
                        if (tag is not null && !tags.Contains(tag)) tags.Add(tag);
                    }
                    break;
                case "WithSummary":
                    var summary = GetStringLiteral(outer.ArgumentList.Arguments[0].Expression);
                    if (summary is not null) route = route with { Summary = summary };
                    break;
                case "WithDescription":
                    var desc = GetStringLiteral(outer.ArgumentList.Arguments[0].Expression);
                    if (desc is not null) route = route with { Description = desc };
                    break;
                case "RequireAuthorization":
                    requiresAuth = true;
                    break;
                case "AllowAnonymous":
                    allowAnonymous = true;
                    break;
                case "Produces":
                    var pStatus = ReadIntArg(outer, model, 0) ?? 200;
                    producesResponses[pStatus] = ReadGenericArg(mae, model, typeMapper)
                                                 ?? ReadTypeofArg(outer, model, typeMapper);
                    break;
                case "ProducesProblem":
                    producesResponses[ReadIntArg(outer, model, 0) ?? 500] = null;
                    break;
                case "Accepts":
                    var accepts = ReadGenericArg(mae, model, typeMapper);
                    if (accepts is not null)
                    {
                        var ct = outer.ArgumentList.Arguments.Count > 0
                            ? GetStringLiteral(outer.ArgumentList.Arguments[0].Expression)
                            : null;
                        acceptsBody = new BodyInfo
                        {
                            ContentType = ct ?? "application/json",
                            Schema = accepts,
                            Required = true,
                        };
                    }
                    break;
            }
            current = outer;
        }

        if (producesResponses.Count > 0)
        {
            var byStatus = (route.Responses ?? new List<ResponseInfo>()).ToDictionary(r => r.Status);
            foreach (var kv in producesResponses)
            {
                var resp = new ResponseInfo
                {
                    Status = kv.Key,
                    Description = ResponseTypeReader.DescribeStatusPublic(kv.Key),
                };
                if (kv.Value is not null) resp = resp with { Schema = kv.Value, ContentType = "application/json" };
                byStatus[kv.Key] = resp;
            }
            route = route with { Responses = byStatus.Values.OrderBy(r => r.Status).ToList() };
        }
        if (acceptsBody is not null) route = route with { RequestBody = acceptsBody };

        if (tags.Count > 0) route = route with { Tags = tags };
        if (!string.IsNullOrEmpty(name)) route = route with { OperationId = name };
        // Group-level RequireAuthorization is a baseline; an explicit leaf
        // RequireAuthorization also sets it, and a leaf AllowAnonymous wins.
        if ((requiresAuth || groupRequiresAuth) && !allowAnonymous && route.Auth is null)
        {
            route = route with
            {
                Auth = new AuthInfo
                {
                    Type = "http",
                    Scheme = "bearer",
                    BearerFormat = "JWT",
                    Id = "bearerAuth",
                },
            };
        }
        return route;
    }

    private static int? ReadIntArg(InvocationExpressionSyntax inv, SemanticModel model, int index)
    {
        if (index >= inv.ArgumentList.Arguments.Count) return null;
        var expr = inv.ArgumentList.Arguments[index].Expression;
        return model.GetConstantValue(expr) is { HasValue: true, Value: int v } ? v : null;
    }

    // The <T> of a generic fluent call like .Produces<T>()/.Accepts<T>().
    private static Schema? ReadGenericArg(MemberAccessExpressionSyntax mae, SemanticModel model, TypeToSchema mapper)
    {
        if (mae.Name is GenericNameSyntax { TypeArgumentList.Arguments.Count: >= 1 } gen)
        {
            var type = model.GetTypeInfo(gen.TypeArgumentList.Arguments[0]).Type;
            if (type is not null) return mapper.Map(type);
        }
        return null;
    }

    // A typeof(T) argument, e.g. .Produces(200, typeof(Foo)).
    private static Schema? ReadTypeofArg(InvocationExpressionSyntax inv, SemanticModel model, TypeToSchema mapper)
    {
        foreach (var arg in inv.ArgumentList.Arguments)
        {
            if (arg.Expression is TypeOfExpressionSyntax to)
            {
                var type = model.GetTypeInfo(to.Type).Type;
                if (type is not null) return mapper.Map(type);
            }
        }
        return null;
    }

    private SourceLocation MakeSourceLocation(InvocationExpressionSyntax inv)
    {
        var loc = inv.GetLocation();
        var span = loc.GetLineSpan();
        return new SourceLocation
        {
            File = NormalizePath(span.Path),
            Line = span.StartLinePosition.Line + 1,
            Column = span.StartLinePosition.Character + 1,
        };
    }

    private void AddDiagnostic(SyntaxNode node, string code, string message, string severity = "warning")
    {
        var span = node.GetLocation().GetLineSpan();
        _errors.Add(new ParseError
        {
            File = NormalizePath(span.Path),
            Line = span.StartLinePosition.Line + 1,
            Message = message,
            Severity = severity,
            Code = code,
        });
    }

    private string NormalizePath(string path)
    {
        if (string.IsNullOrEmpty(path)) return path;
        if (string.IsNullOrEmpty(_repoRoot)) return path.Replace('\\', '/');
        try
        {
            var rel = Path.GetRelativePath(_repoRoot, path);
            return rel.Replace('\\', '/');
        }
        catch
        {
            return path.Replace('\\', '/');
        }
    }
}
