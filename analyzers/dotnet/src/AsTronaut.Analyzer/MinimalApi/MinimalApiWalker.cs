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
                if (decl.Initializer?.Value is not InvocationExpressionSyntax inv) continue;
                var methodName = GetInvokedMethodName(inv);
                if (methodName != "MapGroup") continue;

                var prefix = ResolveGroupPrefixFor(inv, model);
                if (prefix is null) continue;

                if (model.GetDeclaredSymbol(decl) is ILocalSymbol sym)
                {
                    _groupPrefixes[sym] = prefix;
                }
            }
        }
    }

    private void CollectMapInvocations(SyntaxNode root, SemanticModel model)
    {
        foreach (var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var methodName = GetInvokedMethodName(inv);
            if (methodName is null || !MapToVerb.TryGetValue(methodName, out var verb)) continue;
            if (inv.ArgumentList.Arguments.Count < 2) continue;

            if (!IsRoutingExtension(inv, model)) continue;

            var pattern = GetStringLiteral(inv.ArgumentList.Arguments[0].Expression);
            if (pattern is null)
            {
                AddDiagnostic(inv, DiagnosticCodes.DynamicRoutePath,
                    $"{methodName} with a non-literal route path was skipped "
                    + "(only string-literal paths are supported).");
                continue;
            }

            var prefix = ResolveReceiverPrefix(inv, model);
            var combined = CombinePath(prefix, pattern);
            var parsed = RouteTemplateParser.Parse(combined);

            var handler = inv.ArgumentList.Arguments[1].Expression;
            var route = BuildRoute(inv, verb, parsed, handler, model);
            if (route is not null) _routes.Add(route);
        }
    }

    private string? ResolveGroupPrefixFor(InvocationExpressionSyntax mapGroupCall, SemanticModel model)
    {
        if (mapGroupCall.ArgumentList.Arguments.Count == 0) return null;
        var pattern = GetStringLiteral(mapGroupCall.ArgumentList.Arguments[0].Expression);
        if (pattern is null) return null;
        var parentPrefix = ResolveReceiverPrefix(mapGroupCall, model);
        return CombinePath(parentPrefix, pattern);
    }

    private string? ResolveReceiverPrefix(InvocationExpressionSyntax inv, SemanticModel model)
    {
        if (inv.Expression is not MemberAccessExpressionSyntax mae) return null;

        // Case A: chained inline — `app.MapGroup("/api").MapGet(...)`.
        if (mae.Expression is InvocationExpressionSyntax inner)
        {
            var innerName = GetInvokedMethodName(inner);
            if (innerName == "MapGroup")
            {
                return ResolveGroupPrefixFor(inner, model);
            }
            // Non-group inner call — no contribution to prefix.
            return null;
        }

        // Case B: receiver is a local variable.
        if (mae.Expression is IdentifierNameSyntax id)
        {
            var sym = model.GetSymbolInfo(id).Symbol;
            if (sym is not null && _groupPrefixes.TryGetValue(sym, out var prefix))
            {
                return prefix;
            }
        }
        return null;
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
        SemanticModel model)
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
                    queryParams.Add(paramInfo);
                    break;
                case Binding.Header:
                    headerParams.Add(paramInfo);
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
        route = ApplyFluentChain(mapInvocation, model, route, typeMapper);
        return route;
    }

    private enum Binding { Path, Query, Header, Body, Service }

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
        InvocationExpressionSyntax mapInv, SemanticModel model, RouteInfo route, TypeToSchema typeMapper)
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
        if (requiresAuth && !allowAnonymous && route.Auth is null)
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
