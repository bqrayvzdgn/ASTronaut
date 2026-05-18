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

    public ControllerWalker(Compilation compilation, string repoRoot, SchemaContext schemaContext)
    {
        _compilation = compilation;
        _repoRoot = repoRoot;
        _schemaContext = schemaContext;
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

    private void WalkController(INamedTypeSymbol type, string filePath)
    {
        var classRoute = ExtractRouteTemplate(type, type.Name);
        var classTag = StripControllerSuffix(type.Name);

        foreach (var method in type.GetMembers().OfType<IMethodSymbol>())
        {
            if (method.MethodKind != MethodKind.Ordinary) continue;
            if (method.DeclaredAccessibility != Accessibility.Public) continue;
            if (method.IsStatic) continue;

            foreach (var http in AttributeReader.FindAttributes(method, HttpAttributeNames))
            {
                var attrName = http.AttributeClass?.Name ?? "";
                var verb = ResolveVerb(attrName);
                if (verb is null) continue;

                var methodRouteTemplate = AttributeReader.GetStringArg(http, 0) ?? "";
                var combined = CombineRoutes(classRoute, methodRouteTemplate);
                var withPlaceholders = ApplyPlaceholders(combined, type.Name, method.Name);
                var parsed = RouteTemplateParser.Parse(withPlaceholders);

                var route = BuildRoute(method, verb, parsed, classTag, filePath);
                _routes.Add(route);
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

        var typeMapper = new TypeToSchema(_schemaContext);

        foreach (var p in method.Parameters)
        {
            var binding = ResolveBinding(p, pathParamNames);
            var schema = DataAnnotationReader.Apply(typeMapper.Map(p.Type), p);
            var paramInfo = new ParamInfo
            {
                Name = p.Name,
                Schema = schema,
                Required = !p.IsOptional && !IsNullable(p.Type),
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
                    queryParams.Add(paramInfo);
                    break;
                case Binding.Header:
                    headerParams.Add(paramInfo);
                    break;
                case Binding.Body:
                    body = new BodyInfo
                    {
                        ContentType = "application/json",
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
        if (body is not null) routeInfo = routeInfo with { RequestBody = body };

        // Prefer [ProducesResponseType] declarations when present; otherwise
        // fall back to inferring response(s) from the return type and verb.
        var declaredResponses = ResponseTypeReader.Read(method, typeMapper);
        var responses = declaredResponses.Count > 0
            ? declaredResponses
            : BuildResponses(method, typeMapper, verb);
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

    private static bool IsNullable(ITypeSymbol type)
    {
        if (type.NullableAnnotation == NullableAnnotation.Annotated && type.IsReferenceType) return true;
        if (type is INamedTypeSymbol named
            && named.IsGenericType
            && named.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T) return true;
        return false;
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
        if (IsServiceType(parameter.Type)) return Binding.Service;
        if (pathParamNames.Contains(parameter.Name)) return Binding.Path;
        if (IsSimpleType(parameter.Type)) return Binding.Query;
        return Binding.Body;
    }

    // Framework-injected types that should never appear as path / query / body
    // parameters. ASP.NET resolves these from DI or the request context.
    private static bool IsServiceType(ITypeSymbol type)
    {
        var full = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        if (full is "global::System.Threading.CancellationToken"
            or "global::Microsoft.AspNetCore.Http.HttpContext"
            or "global::Microsoft.AspNetCore.Http.HttpRequest"
            or "global::Microsoft.AspNetCore.Http.HttpResponse"
            or "global::System.Security.Claims.ClaimsPrincipal"
            or "global::Microsoft.Extensions.Logging.ILogger"
            or "global::Microsoft.AspNetCore.Mvc.ModelBinding.ModelStateDictionary")
        {
            return true;
        }
        // Generic ILogger<T> — match unconstructed definition.
        if (type is INamedTypeSymbol named && named.IsGenericType)
        {
            var def = named.ConstructedFrom
                ?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            if (def == "global::Microsoft.Extensions.Logging.ILogger<TCategoryName>")
            {
                return true;
            }
        }
        return false;
    }

    private static bool IsSimpleType(ITypeSymbol type)
    {
        // Unwrap Nullable<T>.
        if (type is INamedTypeSymbol nt
            && nt.IsGenericType
            && nt.ConstructedFrom?.SpecialType == SpecialType.System_Nullable_T
            && nt.TypeArguments.Length == 1)
        {
            type = nt.TypeArguments[0];
        }
        switch (type.SpecialType)
        {
            case SpecialType.System_Boolean:
            case SpecialType.System_Char:
            case SpecialType.System_SByte:
            case SpecialType.System_Byte:
            case SpecialType.System_Int16:
            case SpecialType.System_UInt16:
            case SpecialType.System_Int32:
            case SpecialType.System_UInt32:
            case SpecialType.System_Int64:
            case SpecialType.System_UInt64:
            case SpecialType.System_Single:
            case SpecialType.System_Double:
            case SpecialType.System_Decimal:
            case SpecialType.System_String:
                return true;
        }
        var full = type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return full is "global::System.Guid"
            or "global::System.DateTime"
            or "global::System.DateTimeOffset"
            or "global::System.DateOnly"
            or "global::System.TimeOnly"
            or "global::System.TimeSpan"
            or "global::System.Uri";
    }

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

    private SourceLocation MakeSourceLocation(IMethodSymbol method, string filePath)
    {
        var loc = method.Locations.FirstOrDefault(l => l.IsInSource);
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
