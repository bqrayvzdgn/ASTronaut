using System.Text.RegularExpressions;
using AsTronaut.Analyzer.Diagnostics;
using AsTronaut.Analyzer.Discovery;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.Controllers;

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
    private readonly JsonNamingPolicyKind? _namingPolicy;

    public ControllerWalker(Compilation compilation, string repoRoot, SchemaContext schemaContext)
    {
        _compilation = compilation;
        _repoRoot = repoRoot;
        _schemaContext = schemaContext;
        _stringEnums = EnumConfig.UsesStringEnumsByDefault(compilation);
        _namingPolicy = NamingPolicyConfig.Detect(compilation);
    }

    public IReadOnlyList<RouteInfo> Routes => _routes;
    public IReadOnlyList<ParseError> Errors => _errors;

    public void Walk()
    {
        var trees = _compilation.SyntaxTrees
            .OrderBy(t => PathOrder.Key(t.FilePath), StringComparer.Ordinal);
        foreach (var tree in trees)
        {
            var model = _compilation.GetSemanticModel(tree);
            var root = tree.GetRoot();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (model.GetDeclaredSymbol(cls) is not INamedTypeSymbol type) continue;
                if (!IsController(type)) continue;

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
        for (var t = type.BaseType; t is not null; t = t.BaseType)
        {
            var name = t.Name;
            if (name is "ControllerBase" or "Controller") return true;
        }
        return false;
    }

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
        if (IsApiExplorerIgnored(type)) return;

        var classRoute = ExtractRouteTemplate(type, type.Name);
        var classTag = StripControllerSuffix(type.Name);
        var controllerObsolete = AttributeReader.HasAttribute(type, "Obsolete");
        var apiVersions = ExtractApiVersions(type);

        foreach (var method in CollectActionMethods(type))
        {
            if (AttributeReader.HasAttribute(method, "NonAction")) continue;
            if (IsApiExplorerIgnored(method)) continue;

            var methodObsolete = controllerObsolete || AttributeReader.HasAttribute(method, "Obsolete");

            var actionVersions = ResolveActionVersions(method, apiVersions);

            foreach (var (verb, methodRouteTemplate) in CollectVerbRoutes(method))
            {
                var combined = CombineRoutes(classRoute, methodRouteTemplate);
                var withPlaceholders = ApplyPlaceholders(combined, type.Name, method.Name);

                foreach (var template in ExpandApiVersions(withPlaceholders, actionVersions))
                {
                    var parsed = RouteTemplateParser.Parse(template);

                    var route = BuildRoute(method, verb, parsed, classTag, filePath);
                    if (methodObsolete) route.Deprecated = true;
                    _routes.Add(route);
                }
            }
        }
    }

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
        if (methodRoute.StartsWith("/")) return methodRoute;
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

    private static readonly Regex ApiVersionTokenRegex =
        new(@"\{[^{}]*:apiVersion[^{}]*\}", RegexOptions.Compiled | RegexOptions.IgnoreCase);

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
            Tags = { classTag },
            Source = MakeSourceLocation(method, filePath),
        };
        if (docs.Summary is not null) routeInfo.Summary = docs.Summary;
        if (docs.Description is not null) routeInfo.Description = docs.Description;

        var pathParamNames = new HashSet<string>(
            parsed.PathParams.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);

        var pathParams = new List<ParamInfo>(parsed.PathParams);
        var queryParams = new List<ParamInfo>();
        var headerParams = new List<ParamInfo>();
        BodyInfo? body = null;

        var typeMapper = new TypeToSchema(_schemaContext, _stringEnums, _namingPolicy);

        foreach (var p in method.Parameters)
        {
            var binding = ResolveBinding(p, pathParamNames);
            var schema = DataAnnotationReader.Apply(typeMapper.Map(p.Type), p);
            var paramInfo = new ParamInfo
            {
                Name = ResolveParamName(p),
                Schema = schema,
                Required = (!p.IsOptional && !TypeClassifier.IsNullable(p.Type))
                    || DataAnnotationReader.HasRequired(p),
            };
            if (docs.Params.TryGetValue(p.Name, out var paramDoc))
            {
                paramInfo.Description = paramDoc;
            }

            switch (binding)
            {
                case Binding.Path:
                    UpsertPathParam(pathParams, paramInfo);
                    break;
                case Binding.Query:
                    AddQueryParams(queryParams, p, paramInfo);
                    break;
                case Binding.AsParameters:
                    AddAsParameters(pathParams, queryParams, paramInfo, pathParamNames);
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
                    break;
            }
        }

        routeInfo.PathParams.Add(pathParams);
        routeInfo.QueryParams.Add(queryParams);
        routeInfo.HeaderParams.Add(headerParams);
        if (body is not null)
        {
            var consumes = ReadContentTypes(method, "Consumes");
            if (consumes.Count > 0)
            {
                body.ContentType = consumes[0];
                body.ContentTypes.Clear();
                body.ContentTypes.Add(consumes);
            }
            routeInfo.RequestBody = body;
        }

        var declaredResponses = ResponseTypeReader.Read(method, typeMapper);
        var responses = declaredResponses.Count > 0
            ? CompleteDeclaredSchemas(declaredResponses, method, typeMapper, verb)
            : ControllerResultReader.TryRead(method, _compilation, typeMapper)
              ?? BuildResponses(method, typeMapper, verb);

        var produces = ReadContentTypes(method, "Produces");
        if (produces.Count > 0)
        {
            responses = responses
                .Select(r => r.Schema is not null ? WithContentTypes(r, produces) : r)
                .ToList();
        }

        if (docs.ResponseDescriptions.Count > 0)
        {
            responses = responses
                .Select(r => docs.ResponseDescriptions.TryGetValue(r.Status, out var d)
                    ? WithDescription(r, d)
                    : r)
                .ToList();
        }
        routeInfo.Responses.Add(responses);

        var auth = AuthReader.Resolve(method, method.ContainingType);
        if (auth is not null) routeInfo.Auth = auth;

        return routeInfo;
    }

    private static ResponseInfo WithContentTypes(ResponseInfo response, List<string> contentTypes)
    {
        var copy = response.Clone();
        copy.ContentType = contentTypes[0];
        copy.ContentTypes.Clear();
        copy.ContentTypes.Add(contentTypes);
        return copy;
    }

    private static ResponseInfo WithDescription(ResponseInfo response, string description)
    {
        var copy = response.Clone();
        copy.Description = description;
        return copy;
    }

    private List<ResponseInfo> CompleteDeclaredSchemas(
        List<ResponseInfo> declared, IMethodSymbol method, TypeToSchema mapper, string verb)
    {
        if (declared.All(r => r.Schema is not null)) return declared;

        var inferred = ControllerResultReader.TryRead(method, _compilation, mapper)
                       ?? BuildResponses(method, mapper, verb);

        var schemaByStatus = new Dictionary<int, ResponseInfo>();
        foreach (var r in inferred)
        {
            if (r.Schema is null) continue;
            if (!schemaByStatus.ContainsKey(r.Status)) schemaByStatus[r.Status] = r;
        }
        if (schemaByStatus.Count == 0) return declared;

        return declared
            .Select(r => r.Schema is null && schemaByStatus.TryGetValue(r.Status, out var src)
                ? WithSchema(r, src)
                : r)
            .ToList();
    }

    private static ResponseInfo WithSchema(ResponseInfo response, ResponseInfo source)
    {
        var copy = response.Clone();
        copy.Schema = source.Schema;
        copy.ContentType = string.IsNullOrEmpty(source.ContentType) ? "application/json" : source.ContentType;
        return copy;
    }

    private static void UpsertPathParam(List<ParamInfo> pathParams, ParamInfo incoming)
    {
        for (int i = 0; i < pathParams.Count; i++)
        {
            if (string.Equals(pathParams[i].Name, incoming.Name, StringComparison.OrdinalIgnoreCase))
            {
                var existing = pathParams[i];
                var merged = incoming.Schema.Clone();
                merged.Constraints = incoming.Schema.Constraints ?? existing.Schema.Constraints;
                var replacement = incoming.Clone();
                replacement.Name = existing.Name;
                replacement.Schema = merged;
                pathParams[i] = replacement;
                return;
            }
        }
        pathParams.Add(incoming);
    }

    private enum Binding { Path, Query, Header, Body, Service, AsParameters }

    private static Binding ResolveBinding(IParameterSymbol parameter, HashSet<string> pathParamNames)
    {
        if (AttributeReader.HasAttribute(parameter, "AsParameters")) return Binding.AsParameters;
        if (AttributeReader.HasAttribute(parameter, "FromBody")) return Binding.Body;
        if (AttributeReader.HasAttribute(parameter, "FromRoute")) return Binding.Path;
        if (AttributeReader.HasAttribute(parameter, "FromQuery")) return Binding.Query;
        if (AttributeReader.HasAttribute(parameter, "FromHeader")) return Binding.Header;
        if (AttributeReader.HasAttribute(parameter, "FromServices")
            || AttributeReader.HasAttribute(parameter, "FromKeyedServices"))
        {
            return Binding.Service;
        }

        if (TypeClassifier.IsServiceType(parameter.Type)) return Binding.Service;
        if (pathParamNames.Contains(parameter.Name)) return Binding.Path;
        if (TypeClassifier.IsSimpleType(parameter.Type)) return Binding.Query;
        return Binding.Body;
    }

    private void AddQueryParams(List<ParamInfo> queryParams, IParameterSymbol p, ParamInfo paramInfo)
    {
        if (TypeClassifier.IsSimpleType(p.Type))
        {
            queryParams.Add(paramInfo);
            return;
        }
        var obj = ResolveObjectSchema(paramInfo.Schema);
        if (obj is null || obj.Properties.Count == 0)
        {
            queryParams.Add(paramInfo);
            return;
        }
        var required = obj.RequiredProperties;
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

    private static string ResolveParamName(IParameterSymbol p)
    {
        var attr = AttributeReader.FindAttribute(p, "FromHeader", "FromQuery", "FromRoute");
        if (attr is not null)
        {
            var name = AttributeReader.GetNamedStringArg(attr, "Name");
            if (!string.IsNullOrEmpty(name)) return name!;
        }
        return p.Name;
    }

    private void AddAsParameters(
        List<ParamInfo> pathParams,
        List<ParamInfo> queryParams,
        ParamInfo paramInfo,
        HashSet<string> pathParamNames)
    {
        var obj = ResolveObjectSchema(paramInfo.Schema);
        if (obj is null || obj.Properties.Count == 0)
        {
            queryParams.Add(paramInfo);
            return;
        }
        var required = obj.RequiredProperties;
        foreach (var kvp in obj.Properties)
        {
            var flattened = new ParamInfo
            {
                Name = kvp.Key,
                Schema = kvp.Value,
                Required = required.Contains(kvp.Key),
            };
            if (pathParamNames.Contains(kvp.Key))
            {
                UpsertPathParam(pathParams, flattened);
            }
            else
            {
                queryParams.Add(flattened);
            }
        }
    }

    private Schema? ResolveObjectSchema(Schema schema)
    {
        if (schema.Kind == Schema.Types.Kind.Object) return schema;
        if (schema.Kind == Schema.Types.Kind.Reference && schema.HasRefName
            && _schemaContext.SharedSchemas.TryGetValue(schema.RefName, out var target))
        {
            return target;
        }
        return null;
    }

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
            response.Schema = mapper.Map(unwrapped);
            response.ContentType = "application/json";
        }
        return new List<ResponseInfo> { response };
    }

    private static ITypeSymbol? UnwrapReturnWrappers(ITypeSymbol type)
    {
        if (type.SpecialType == SpecialType.System_Void) return null;

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
