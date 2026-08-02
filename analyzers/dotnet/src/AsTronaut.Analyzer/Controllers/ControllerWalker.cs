using System.Text.RegularExpressions;
using AsTronaut.Analyzer.Diagnostics;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.Controllers;

// Discovers ASP.NET Core Controller actions and emits RouteInfo. Operates on a
// Roslyn Compilation: iterates all class declarations across all syntax trees,
// keeps the ones that look like controllers, then enumerates their action
// methods.
public sealed class ControllerWalker
{
    private static readonly string[] HttpAttributeNames =
    {
        "HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch",
        "HttpHead", "HttpOptions",
    };

    private static readonly Dictionary<string, string> HttpAttributeToMethod = new()
    {
        ["HttpGet"] = "GET",
        ["HttpPost"] = "POST",
        ["HttpPut"] = "PUT",
        ["HttpDelete"] = "DELETE",
        ["HttpPatch"] = "PATCH",
        ["HttpHead"] = "HEAD",
        ["HttpOptions"] = "OPTIONS",
    };

    private readonly Compilation _compilation;
    private readonly List<RouteInfo> _routes = new();
    private readonly List<ParseError> _errors = new();
    private readonly string _repoRoot;
    private readonly SchemaContext _schemaContext;
    private readonly bool _stringEnums;

    public ControllerWalker(Compilation compilation, string repoRoot, SchemaContext schemaContext)
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
        foreach (var tree in _compilation.SyntaxTrees)
        {
            var model = _compilation.GetSemanticModel(tree);
            var root = tree.GetRoot();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(cls) is not INamedTypeSymbol type) continue;
                if (!IsController(type)) continue;

                // A non-abstract OPEN generic controller (`Ctrl<T> : ControllerBase`)
                // has unbound type parameters: any route emitted for it would bind
                // the unresolved T. Skip it and surface the skip as a W004 warning
                // instead of dropping it silently. (A concrete controller over a
                // closed generic base — `Orders : Base<Order>` — is not generic here
                // and is unaffected.)
                if (IsOpenGeneric(type))
                {
                    _errors.Add(MakeSkippedControllerError(type, tree.FilePath));
                    continue;
                }

                WalkController(type, tree.FilePath);
            }
        }
    }

    private static bool IsController(INamedTypeSymbol type)
    {
        if (type.IsAbstract) return false;
        if (AttributeReader.HasAttribute(type, "ApiController")) return true;
        // Inherits from ControllerBase or Controller.
        for (var t = type.BaseType; t is not null; t = t.BaseType)
        {
            var name = t.Name;
            if (name is "ControllerBase" or "Controller") return true;
        }
        return false;
    }

    // True for an unbound generic definition such as `class Ctrl<T>` whose type
    // parameters are still open (not constructed to concrete arguments).
    private static bool IsOpenGeneric(INamedTypeSymbol type) =>
        type.IsGenericType
        && type.TypeArguments.Any(a => a.TypeKind == TypeKind.TypeParameter);

    private ParseError MakeSkippedControllerError(INamedTypeSymbol type, string filePath)
    {
        var source = MakeSourceLocation(type, filePath);
        return new ParseError
        {
            File = source.File,
            Line = source.Line,
            Message = $"Open generic controller '{type.Name}' was skipped; "
                + "route binding requires a concrete type argument.",
            Severity = "warning",
            Code = DiagnosticCodes.SkippedController,
        };
    }

    private void WalkController(INamedTypeSymbol type, string filePath)
    {
        // [ApiExplorerSettings(IgnoreApi = true)] on the controller hides all
        // of its actions from the generated surface.
        if (IsApiExplorerIgnored(type)) return;

        var classRoute = ExtractRouteTemplate(type, type.Name);
        var classTag = StripControllerSuffix(type.Name);
        var controllerObsolete = AttributeReader.HasAttribute(type, "Obsolete");
        // URL-segment API versions declared via [ApiVersion("x")] on the
        // controller. Used to instantiate a {version:apiVersion} route token.
        var apiVersions = ExtractApiVersions(type);

        foreach (var method in CollectActionMethods(type))
        {
            // [NonAction] and [ApiExplorerSettings(IgnoreApi = true)] opt a
            // single method out of routing.
            if (AttributeReader.HasAttribute(method, "NonAction")) continue;
            if (IsApiExplorerIgnored(method)) continue;

            var methodObsolete = controllerObsolete || AttributeReader.HasAttribute(method, "Obsolete");

            // [MapToApiVersion("x")] on the action pins it to a subset of the
            // controller's declared versions. When present, the action fans out
            // only to those versions (intersected with what the controller
            // actually declares) instead of every controller version.
            var actionVersions = ResolveActionVersions(method, apiVersions);

            foreach (var (verb, methodRouteTemplate) in CollectVerbRoutes(method))
            {
                var combined = CombineRoutes(classRoute, methodRouteTemplate);
                var withPlaceholders = ApplyPlaceholders(combined, type.Name, method.Name);

                // A {version:apiVersion} token combined with declared
                // [ApiVersion] values fans one action out into a concrete route
                // per version; otherwise this yields the single template as-is.
                foreach (var template in ExpandApiVersions(withPlaceholders, actionVersions))
                {
                    var parsed = RouteTemplateParser.Parse(template);

                    var route = BuildRoute(method, verb, parsed, classTag, filePath);
                    if (methodObsolete) route = route with { Deprecated = true };
                    _routes.Add(route);
                }
            }
        }
    }

    // Enumerates action methods for the concrete controller, walking up the
    // inheritance chain so actions declared on a base controller are included.
    // The walk stops before the framework base types (ControllerBase/Controller)
    // and System.Object. Members are deduplicated by name+signature so an
    // overridden or re-declared action is emitted once, with the most-derived
    // declaration winning.
    private static IEnumerable<IMethodSymbol> CollectActionMethods(INamedTypeSymbol type)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var t = type; t is not null; t = t.BaseType)
        {
            if (t.SpecialType == SpecialType.System_Object) break;
            if (t.Name is "ControllerBase" or "Controller") break;

            foreach (var method in t.GetMembers().OfType<IMethodSymbol>())
            {
                if (method.MethodKind != MethodKind.Ordinary) continue;
                if (method.DeclaredAccessibility != Accessibility.Public) continue;
                if (method.IsStatic) continue;

                // Most-derived declaration was already yielded for this signature.
                if (!seen.Add(SignatureKey(method))) continue;
                yield return method;
            }
        }
    }

    private static string SignatureKey(IMethodSymbol method)
    {
        var parameters = string.Join(
            ",",
            method.Parameters.Select(p =>
                p.Type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)));
        return method.Name + "(" + parameters + ")";
    }

    // True when the symbol carries [ApiExplorerSettings(IgnoreApi = true)].
    private static bool IsApiExplorerIgnored(ISymbol symbol)
    {
        var attr = AttributeReader.FindAttribute(symbol, "ApiExplorerSettings");
        if (attr is null) return false;
        foreach (var na in attr.NamedArguments)
        {
            if (na.Key == "IgnoreApi" && na.Value.Value is bool b) return b;
        }
        return false;
    }

    // Yields (HTTP verb, method route template) pairs for an action, drawn from
    // both the per-verb [HttpGet]/[HttpPost]/… attributes and [AcceptVerbs("GET",
    // "POST")], which lists its verbs as constructor arguments and carries an
    // optional named `Route` template.
    private static IEnumerable<(string Verb, string Template)> CollectVerbRoutes(IMethodSymbol method)
    {
        foreach (var http in AttributeReader.FindAttributes(method, HttpAttributeNames))
        {
            var verb = ResolveVerb(http.AttributeClass?.Name ?? "");
            if (verb is null) continue;
            yield return (verb, AttributeReader.GetStringArg(http, 0) ?? "");
        }

        foreach (var accept in AttributeReader.FindAttributes(method, "AcceptVerbs"))
        {
            var template = AttributeReader.GetNamedStringArg(accept, "Route") ?? "";
            foreach (var raw in AttributeReader.GetStringArgs(accept))
            {
                var verb = raw.Trim().ToUpperInvariant();
                if (verb.Length == 0) continue;
                yield return (verb, template);
            }
        }
    }

    private static string? ResolveVerb(string attrName)
    {
        var name = attrName.EndsWith("Attribute", StringComparison.Ordinal)
            ? attrName.Substring(0, attrName.Length - 9)
            : attrName;
        return HttpAttributeToMethod.TryGetValue(name, out var verb) ? verb : null;
    }

    private static string ExtractRouteTemplate(INamedTypeSymbol type, string typeName)
    {
        var routeAttr = AttributeReader.FindAttribute(type, "Route");
        if (routeAttr is null) return "";
        var template = AttributeReader.GetStringArg(routeAttr, 0) ?? "";
        return template;
    }

    private static string CombineRoutes(string classRoute, string methodRoute)
    {
        if (string.IsNullOrEmpty(methodRoute)) return classRoute;
        if (methodRoute.StartsWith("/")) return methodRoute; // absolute override
        if (string.IsNullOrEmpty(classRoute)) return methodRoute;
        return classRoute.TrimEnd('/') + "/" + methodRoute.TrimStart('/');
    }

    private static string ApplyPlaceholders(string template, string typeName, string methodName)
    {
        var controller = StripControllerSuffix(typeName);
        return template
            .Replace("[controller]", controller, StringComparison.OrdinalIgnoreCase)
            .Replace("[action]", methodName, StringComparison.OrdinalIgnoreCase);
    }

    // Matches a route token carrying the `apiVersion` constraint, e.g.
    // "{version:apiVersion}" inside a segment like "v{version:apiVersion}".
    private static readonly Regex ApiVersionTokenRegex =
        new(@"\{[^{}]*:apiVersion[^{}]*\}", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Version strings declared by [ApiVersion("x")] attributes on the controller,
    // in declaration order. Empty when the controller is not versioned.
    private static List<string> ExtractApiVersions(INamedTypeSymbol type)
    {
        var versions = new List<string>();
        foreach (var attr in AttributeReader.FindAttributes(type, "ApiVersion"))
        {
            var version = AttributeReader.GetStringArg(attr, 0);
            if (!string.IsNullOrEmpty(version)) versions.Add(version!);
        }
        return versions;
    }

    // The effective versions an action fans out to. Without [MapToApiVersion]
    // this is the controller's full version set (unchanged behavior). With one
    // or more [MapToApiVersion("x")], the action is restricted to exactly those
    // mapped versions, preserving the controller's declaration order and keeping
    // only versions the controller actually declares (a mapped version outside
    // the controller set does not invent a route).
    private static List<string> ResolveActionVersions(
        IMethodSymbol method, List<string> controllerVersions)
    {
        var mapped = new List<string>();
        foreach (var attr in AttributeReader.FindAttributes(method, "MapToApiVersion"))
        {
            var version = AttributeReader.GetStringArg(attr, 0);
            if (!string.IsNullOrEmpty(version)) mapped.Add(version!);
        }

        if (mapped.Count == 0) return controllerVersions;

        return controllerVersions.Where(mapped.Contains).ToList();
    }

    // When the template contains an apiVersion token AND versions are declared,
    // yields one concrete template per version (token replaced by the literal
    // version). Otherwise yields the template unchanged — so unversioned
    // controllers, and versioned templates without the token, are untouched.
    private static IEnumerable<string> ExpandApiVersions(
        string template, IReadOnlyList<string> versions)
    {
        if (versions.Count == 0 || !ApiVersionTokenRegex.IsMatch(template))
        {
            yield return template;
            yield break;
        }
        foreach (var version in versions)
        {
            yield return ApiVersionTokenRegex.Replace(template, version);
        }
    }

    private static string StripControllerSuffix(string typeName)
    {
        const string suffix = "Controller";
        return typeName.EndsWith(suffix, StringComparison.Ordinal)
            ? typeName.Substring(0, typeName.Length - suffix.Length)
            : typeName;
    }

    private RouteInfo BuildRoute(
        IMethodSymbol method,
        string verb,
        RouteTemplateParser.Result parsed,
        string classTag,
        string filePath)
    {
        var docs = XmlDocReader.From(method);
        var routeInfo = new RouteInfo
        {
            Method = verb,
            Path = parsed.NormalizedPath,
            OperationId = method.Name,
            Tags = new List<string> { classTag },
            Source = MakeSourceLocation(method, filePath),
        };
        if (docs.Summary is not null) routeInfo = routeInfo with { Summary = docs.Summary };
        if (docs.Description is not null) routeInfo = routeInfo with { Description = docs.Description };

        var pathParamNames = new HashSet<string>(
            parsed.PathParams.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);

        var pathParams = new List<ParamInfo>(parsed.PathParams);
        var queryParams = new List<ParamInfo>();
        var headerParams = new List<ParamInfo>();
        BodyInfo? body = null;

        var typeMapper = new TypeToSchema(_schemaContext, _stringEnums);

        foreach (var p in method.Parameters)
        {
            var binding = ResolveBinding(p, pathParamNames);
            var schema = DataAnnotationReader.Apply(typeMapper.Map(p.Type), p);
            var paramInfo = new ParamInfo
            {
                Name = p.Name,
                Schema = schema,
                // Required when the type/optionality says so, OR an explicit
                // [Required] is present (which overrides a nullable annotation) —
                // matching how DTO properties are handled in TypeToSchema.
                Required = (!p.IsOptional && !TypeClassifier.IsNullable(p.Type))
                    || DataAnnotationReader.HasRequired(p),
            };
            if (docs.Params.TryGetValue(p.Name, out var paramDoc))
            {
                paramInfo = paramInfo with { Description = paramDoc };
            }

            switch (binding)
            {
                case Binding.Path:
                    UpsertPathParam(pathParams, paramInfo);
                    break;
                case Binding.Query:
                    AddQueryParams(queryParams, p, paramInfo);
                    break;
                case Binding.Header:
                    headerParams.Add(paramInfo);
                    break;
                case Binding.Body:
                    body = new BodyInfo
                    {
                        ContentType = IsFormBinding(p) ? "multipart/form-data" : "application/json",
                        Schema = schema,
                        Required = paramInfo.Required,
                    };
                    break;
                case Binding.Service:
                    // DI-injected service (CancellationToken, HttpContext, ILogger…).
                    break;
            }
        }

        if (pathParams.Count > 0) routeInfo = routeInfo with { PathParams = pathParams };
        if (queryParams.Count > 0) routeInfo = routeInfo with { QueryParams = queryParams };
        if (headerParams.Count > 0) routeInfo = routeInfo with { HeaderParams = headerParams };
        if (body is not null)
        {
            // [Consumes(...)] overrides the inferred request content type(s).
            var consumes = ReadContentTypes(method, "Consumes");
            if (consumes.Count > 0)
            {
                body = body with { ContentType = consumes[0], ContentTypes = consumes };
            }
            routeInfo = routeInfo with { RequestBody = body };
        }

        // Prefer [ProducesResponseType] declarations when present; otherwise
        // fall back to inferring response(s) from the return type and verb.
        var declaredResponses = ResponseTypeReader.Read(method, typeMapper);
        var responses = declaredResponses.Count > 0
            ? declaredResponses
            // For IActionResult/ActionResult actions, recover responses from the
            // body's return statements before falling back to the return type.
            : ControllerResultReader.TryRead(method, _compilation, typeMapper)
              ?? BuildResponses(method, typeMapper, verb);

        // [Produces(...)] declares the produced content type(s) for responses
        // that carry a body schema.
        var produces = ReadContentTypes(method, "Produces");
        if (produces.Count > 0)
        {
            responses = responses
                .Select(r => r.Schema is not null
                    ? r with { ContentType = produces[0], ContentTypes = produces }
                    : r)
                .ToList();
        }

        // Apply documented <response code="NNN">text</response> descriptions,
        // overriding the inferred/default description for matching statuses.
        if (docs.ResponseDescriptions.Count > 0)
        {
            responses = responses
                .Select(r => docs.ResponseDescriptions.TryGetValue(r.Status, out var d)
                    ? r with { Description = d }
                    : r)
                .ToList();
        }
        routeInfo = routeInfo with { Responses = responses };

        var auth = AuthReader.Resolve(method, method.ContainingType);
        if (auth is not null) routeInfo = routeInfo with { Auth = auth };

        return routeInfo;
    }

    private static void UpsertPathParam(List<ParamInfo> pathParams, ParamInfo incoming)
    {
        for (int i = 0; i < pathParams.Count; i++)
        {
            if (string.Equals(pathParams[i].Name, incoming.Name, StringComparison.OrdinalIgnoreCase))
            {
                // Merge: prefer the C# parameter type/format (more specific than the
                // route-template fallback), but keep any constraints the route
                // template introduced (e.g. `{id:int:min(1)}` carries Minimum=1).
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

    private enum Binding { Path, Query, Header, Body, Service }

    private static Binding ResolveBinding(IParameterSymbol parameter, HashSet<string> pathParamNames)
    {
        if (AttributeReader.HasAttribute(parameter, "FromBody")) return Binding.Body;
        if (AttributeReader.HasAttribute(parameter, "FromRoute")) return Binding.Path;
        if (AttributeReader.HasAttribute(parameter, "FromQuery")) return Binding.Query;
        if (AttributeReader.HasAttribute(parameter, "FromHeader")) return Binding.Header;
        if (AttributeReader.HasAttribute(parameter, "FromServices")
            || AttributeReader.HasAttribute(parameter, "FromKeyedServices"))
        {
            return Binding.Service;
        }

        // Implicit binding (ApiController convention):
        // - If the type is a well-known framework service (CancellationToken,
        //   HttpContext, ILogger, ...), skip it entirely.
        // - If the parameter name matches a path token ⇒ path.
        // - Else, if the type is a simple/primitive type ⇒ query.
        // - Else (complex type) ⇒ body.
        if (TypeClassifier.IsServiceType(parameter.Type)) return Binding.Service;
        if (pathParamNames.Contains(parameter.Name)) return Binding.Path;
        if (TypeClassifier.IsSimpleType(parameter.Type)) return Binding.Query;
        return Binding.Body;
    }

    // A [FromQuery] scalar is a single query parameter; a [FromQuery] complex
    // object binds each of its properties as its own query parameter (ASP.NET
    // model binding), so flatten it into per-property params.
    private void AddQueryParams(List<ParamInfo> queryParams, IParameterSymbol p, ParamInfo paramInfo)
    {
        if (TypeClassifier.IsSimpleType(p.Type))
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

    // Content types from [Consumes]/[Produces] on the method, falling back to
    // the controller. Empty when neither is present.
    private static List<string> ReadContentTypes(IMethodSymbol method, string attrName)
    {
        var attr = AttributeReader.FindAttribute(method, attrName)
                   ?? AttributeReader.FindAttribute(method.ContainingType, attrName);
        return attr is null ? new List<string>() : AttributeReader.GetStringArgs(attr);
    }

    private static bool IsFormBinding(IParameterSymbol parameter) =>
        AttributeReader.HasAttribute(parameter, "FromForm") || TypeClassifier.IsFormFileType(parameter.Type);

    private static List<ResponseInfo> BuildResponses(IMethodSymbol method, TypeToSchema mapper, string verb)
    {
        var unwrapped = UnwrapReturnWrappers(method.ReturnType);
        var hasSchema = unwrapped is not null
            && !IsActionResultInterface(unwrapped)
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
        if (type.SpecialType == SpecialType.System_Void) return null;

        var current = type;
        for (int i = 0; i < 4; i++) // bounded unwrap depth
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
            // Bare Task / ValueTask (non-generic) → no payload.
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

    private static bool IsActionResultInterface(ITypeSymbol type)
    {
        var full = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return full is "global::Microsoft.AspNetCore.Mvc.IActionResult"
            or "global::Microsoft.AspNetCore.Http.IResult"
            or "global::Microsoft.AspNetCore.Mvc.ActionResult";
    }

    private SourceLocation MakeSourceLocation(ISymbol symbol, string filePath)
    {
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc is null)
        {
            return new SourceLocation { File = NormalizePath(filePath) };
        }
        var span = loc.GetLineSpan();
        return new SourceLocation
        {
            File = NormalizePath(span.Path),
            Line = span.StartLinePosition.Line + 1,
            Column = span.StartLinePosition.Character + 1,
        };
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
