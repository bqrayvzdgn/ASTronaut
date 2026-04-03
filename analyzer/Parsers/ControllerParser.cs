using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using AutoDocAnalyzer.Models;

namespace AutoDocAnalyzer.Parsers;

public class ControllerParser
{
    private static readonly Dictionary<string, string> HttpMethodAttributes = new()
    {
        { "HttpGet", "GET" },
        { "HttpGetAttribute", "GET" },
        { "HttpPost", "POST" },
        { "HttpPostAttribute", "POST" },
        { "HttpPut", "PUT" },
        { "HttpPutAttribute", "PUT" },
        { "HttpDelete", "DELETE" },
        { "HttpDeleteAttribute", "DELETE" },
        { "HttpPatch", "PATCH" },
        { "HttpPatchAttribute", "PATCH" },
        { "HttpHead", "HEAD" },
        { "HttpHeadAttribute", "HEAD" },
        { "HttpOptions", "OPTIONS" },
        { "HttpOptionsAttribute", "OPTIONS" },
    };

    private static readonly Dictionary<string, string> ParamSourceAttributes = new()
    {
        { "FromBody", "body" },
        { "FromBodyAttribute", "body" },
        { "FromQuery", "query" },
        { "FromQueryAttribute", "query" },
        { "FromRoute", "path" },
        { "FromRouteAttribute", "path" },
        { "FromHeader", "header" },
        { "FromHeaderAttribute", "header" },
    };

    private readonly SemanticModel? _semanticModel;
    private readonly HashSet<string> _visitedTypes = new();

    public ControllerParser(SemanticModel? semanticModel)
    {
        _semanticModel = semanticModel;
    }

    public List<RouteInfo> Parse(SyntaxTree tree, string filePath)
    {
        var routes = new List<RouteInfo>();
        var root = tree.GetCompilationUnitRoot();

        var classes = root.DescendantNodes().OfType<ClassDeclarationSyntax>();

        foreach (var classDecl in classes)
        {
            if (!HasAttribute(classDecl.AttributeLists, "ApiController"))
                continue;

            var controllerName = classDecl.Identifier.Text;
            var baseName = controllerName.EndsWith("Controller")
                ? controllerName[..^"Controller".Length]
                : controllerName;

            var routePrefix = ExtractRouteTemplate(classDecl.AttributeLists);
            if (routePrefix != null)
            {
                routePrefix = routePrefix
                    .Replace("[controller]", baseName.ToLowerInvariant())
                    .Replace("[Controller]", baseName.ToLowerInvariant());
            }

            var classHasAuth = HasAttribute(classDecl.AttributeLists, "Authorize");

            var methods = classDecl.Members.OfType<MethodDeclarationSyntax>();

            foreach (var method in methods)
            {
                var httpMethod = ExtractHttpMethod(method.AttributeLists);
                if (httpMethod == null)
                    continue;

                var methodTemplate = ExtractHttpRouteTemplate(method.AttributeLists);
                var fullPath = BuildFullPath(routePrefix, methodTemplate);

                var hasAuth = classHasAuth || HasAttribute(method.AttributeLists, "Authorize");
                var allowAnon = HasAttribute(method.AttributeLists, "AllowAnonymous");

                var description = ExtractXmlDocSummary(method);

                var route = new RouteInfo
                {
                    Path = fullPath,
                    Method = httpMethod,
                    Controller = controllerName,
                    RoutePrefix = routePrefix,
                    Auth = hasAuth && !allowAnon ? "Bearer" : null,
                    Description = description,
                    Source = filePath,
                };

                ExtractParameters(method, route);
                ExtractResponseType(method, route);

                routes.Add(route);
            }
        }

        return routes;
    }

    private static bool HasAttribute(SyntaxList<AttributeListSyntax> attributeLists, string name)
    {
        return attributeLists
            .SelectMany(al => al.Attributes)
            .Any(a =>
            {
                var attrName = a.Name.ToString();
                return attrName == name || attrName == name + "Attribute";
            });
    }

    private static string? ExtractRouteTemplate(SyntaxList<AttributeListSyntax> attributeLists)
    {
        var routeAttr = attributeLists
            .SelectMany(al => al.Attributes)
            .FirstOrDefault(a =>
            {
                var name = a.Name.ToString();
                return name == "Route" || name == "RouteAttribute";
            });

        if (routeAttr?.ArgumentList?.Arguments.Count > 0)
        {
            var arg = routeAttr.ArgumentList.Arguments[0];
            return ExtractStringLiteral(arg.Expression);
        }

        return null;
    }

    private static string? ExtractHttpRouteTemplate(SyntaxList<AttributeListSyntax> attributeLists)
    {
        foreach (var attrList in attributeLists)
        {
            foreach (var attr in attrList.Attributes)
            {
                var name = attr.Name.ToString();
                if (HttpMethodAttributes.ContainsKey(name) &&
                    attr.ArgumentList?.Arguments.Count > 0)
                {
                    var arg = attr.ArgumentList.Arguments[0];
                    return ExtractStringLiteral(arg.Expression);
                }
            }
        }

        return null;
    }

    private static string? ExtractHttpMethod(SyntaxList<AttributeListSyntax> attributeLists)
    {
        foreach (var attrList in attributeLists)
        {
            foreach (var attr in attrList.Attributes)
            {
                var name = attr.Name.ToString();
                if (HttpMethodAttributes.TryGetValue(name, out var method))
                    return method;
            }
        }

        return null;
    }

    private static string BuildFullPath(string? prefix, string? template)
    {
        var parts = new List<string>();

        if (!string.IsNullOrEmpty(prefix))
            parts.Add(prefix.Trim('/'));

        if (!string.IsNullOrEmpty(template))
            parts.Add(template.Trim('/'));

        var path = "/" + string.Join("/", parts);

        // Strip route constraints: {id:guid} → {id}, {slug:regex(...)} → {slug}
        path = Regex.Replace(path, @"\{(\w+):[^}]+\}", "{$1}");

        return path;
    }

    private static readonly HashSet<string> FormFileTypes = new()
    {
        "IFormFile", "IFormFileCollection", "IFormFile?",
        "List<IFormFile>", "IList<IFormFile>", "IEnumerable<IFormFile>",
    };

    private void ExtractParameters(MethodDeclarationSyntax method, RouteInfo route)
    {
        foreach (var param in method.ParameterList.Parameters)
        {
            var paramName = param.Identifier.Text;
            var paramType = param.Type?.ToString() ?? "string";
            var source = DetermineParamSource(param, route.Path);

            // IFormFile → multipart/form-data
            if (FormFileTypes.Contains(paramType))
            {
                route.RequestBody = new RequestBodyInfo
                {
                    Type = paramType,
                    ContentType = "multipart/form-data",
                    Properties = new List<Models.PropertyInfo>
                    {
                        new() { Name = paramName, Type = "binary", Required = true },
                    },
                };
                continue;
            }

            if (source == "body")
            {
                _visitedTypes.Clear();
                var properties = ResolveTypeProperties(param.Type);
                route.RequestBody = new RequestBodyInfo
                {
                    Type = paramType,
                    Properties = properties,
                };
                continue;
            }

            route.Params.Add(new ParamInfo
            {
                Name = paramName,
                In = source,
                Type = MapCSharpTypeToJsonType(paramType),
                Required = param.Default == null && !paramType.EndsWith("?"),
            });
        }
    }

    private static string DetermineParamSource(ParameterSyntax param, string routePath)
    {
        foreach (var attrList in param.AttributeLists)
        {
            foreach (var attr in attrList.Attributes)
            {
                var name = attr.Name.ToString();
                if (ParamSourceAttributes.TryGetValue(name, out var source))
                    return source;
            }
        }

        // If the parameter name appears in the route path as {paramName}, it's a path param
        var paramName = param.Identifier.Text;
        if (routePath.Contains($"{{{paramName}}}") || routePath.Contains($"{{{paramName}:"))
            return "path";

        // If it's a complex type (not a primitive), assume body for POST/PUT
        var typeName = param.Type?.ToString() ?? "";
        if (!IsPrimitiveType(typeName))
            return "body";

        return "query";
    }

    private static bool IsPrimitiveType(string typeName)
    {
        var cleanType = typeName.TrimEnd('?');
        return cleanType switch
        {
            "int" or "long" or "short" or "byte" or "float" or "double" or "decimal"
                or "bool" or "string" or "char" or "Guid" or "DateTime" or "DateTimeOffset"
                or "TimeSpan" or "Int32" or "Int64" or "Int16" or "Byte" or "Single"
                or "Double" or "Decimal" or "Boolean" or "String" or "Char" => true,
            _ => false,
        };
    }

    private static readonly Dictionary<string, int> ResultMethodStatusCodes = new()
    {
        { "Ok", 200 },
        { "Created", 201 },
        { "CreatedAtAction", 201 },
        { "CreatedAtRoute", 201 },
        { "NoContent", 204 },
        { "BadRequest", 400 },
        { "Unauthorized", 401 },
        { "Forbid", 403 },
        { "NotFound", 404 },
        { "Conflict", 409 },
    };

    private void ExtractResponseType(MethodDeclarationSyntax method, RouteInfo route)
    {
        var returnType = method.ReturnType.ToString();

        // Strip Task<> wrapper
        returnType = UnwrapGenericType(returnType, "Task");

        // Strip ActionResult<T>, IActionResult, etc.
        var innerType = UnwrapGenericType(returnType, "ActionResult");
        if (innerType == returnType)
            innerType = UnwrapGenericType(returnType, "IActionResult");

        if (innerType != "void" && innerType != "IActionResult" && innerType != "ActionResult")
        {
            _visitedTypes.Clear();
            var properties = ResolveTypeProperties(innerType);

            route.Responses.Add(new ResponseInfo
            {
                Status = route.Method == "POST" ? 201 : 200,
                Type = innerType,
                Properties = properties,
            });
            return;
        }

        // For IActionResult/ActionResult, try to infer from return statements
        var returnStatements = method.DescendantNodes().OfType<ReturnStatementSyntax>();
        var seenStatuses = new HashSet<int>();

        foreach (var ret in returnStatements)
        {
            if (ret.Expression is InvocationExpressionSyntax invocation)
            {
                var responseInfo = ExtractControllerResultInfo(invocation);
                if (responseInfo != null && seenStatuses.Add(responseInfo.Status))
                {
                    route.Responses.Add(responseInfo);
                }
            }
        }

        // Fallback if no return statements found
        if (route.Responses.Count == 0)
        {
            route.Responses.Add(new ResponseInfo
            {
                Status = route.Method == "POST" ? 201 : 200,
                Type = null,
                Properties = new List<Models.PropertyInfo>(),
            });
        }
    }

    private ResponseInfo? ExtractControllerResultInfo(InvocationExpressionSyntax invocation)
    {
        string methodName;

        if (invocation.Expression is IdentifierNameSyntax identifier)
        {
            // Ok(...), NotFound(...), etc.
            methodName = identifier.Identifier.Text;
        }
        else if (invocation.Expression is MemberAccessExpressionSyntax memberAccess)
        {
            // this.Ok(...), StatusCode(...)
            methodName = memberAccess.Name.Identifier.Text;
        }
        else
        {
            return null;
        }

        if (!ResultMethodStatusCodes.TryGetValue(methodName, out var status))
            return null;

        // Try to resolve type from the first argument
        string? typeName = null;
        var properties = new List<Models.PropertyInfo>();

        if (invocation.ArgumentList.Arguments.Count > 0)
        {
            var firstArg = invocation.ArgumentList.Arguments[0].Expression;

            // Try semantic model to get the type of the argument
            if (_semanticModel != null)
            {
                var typeInfo = _semanticModel.GetTypeInfo(firstArg);
                var argType = typeInfo.Type;

                if (argType != null && argType.SpecialType == SpecialType.None
                    && argType.TypeKind != TypeKind.Error
                    && argType.Name != "Object")
                {
                    typeName = argType.Name;
                    _visitedTypes.Clear();

                    // Use type symbol directly for cross-project resolution
                    if (argType is INamedTypeSymbol namedArgType)
                        properties = ExtractPropertiesFromSymbol(namedArgType);
                    else
                        properties = ResolveTypeProperties(typeName);
                }
            }
        }

        return new ResponseInfo
        {
            Status = status,
            Type = typeName,
            Properties = properties,
        };
    }

    private static string UnwrapGenericType(string typeName, string wrapperName)
    {
        if (typeName.StartsWith(wrapperName + "<") && typeName.EndsWith(">"))
        {
            return typeName[(wrapperName.Length + 1)..^1];
        }

        return typeName;
    }

    private List<Models.PropertyInfo> ResolveTypeProperties(TypeSyntax? typeSyntax)
    {
        if (typeSyntax == null)
            return new List<Models.PropertyInfo>();

        var typeName = typeSyntax.ToString();
        if (IsPrimitiveType(typeName))
            return new List<Models.PropertyInfo>();

        // Try direct semantic resolution from syntax node (resolves cross-project types)
        if (_semanticModel != null)
        {
            var typeInfo = _semanticModel.GetTypeInfo(typeSyntax);
            if (typeInfo.Type is INamedTypeSymbol namedType
                && namedType.TypeKind != TypeKind.Error
                && !_visitedTypes.Contains(typeName))
            {
                _visitedTypes.Add(typeName);
                var props = ExtractPropertiesFromSymbol(namedType);
                if (props.Count > 0)
                    return props;
            }
        }

        return ResolveTypeProperties(typeName);
    }

    private List<Models.PropertyInfo> ResolveTypeProperties(string typeName)
    {
        if (string.IsNullOrEmpty(typeName) || IsPrimitiveType(typeName))
            return new List<Models.PropertyInfo>();

        // Handle collection types
        var unwrapped = UnwrapGenericType(typeName, "List");
        if (unwrapped == typeName) unwrapped = UnwrapGenericType(typeName, "IList");
        if (unwrapped == typeName) unwrapped = UnwrapGenericType(typeName, "IEnumerable");
        if (unwrapped == typeName) unwrapped = UnwrapGenericType(typeName, "ICollection");
        if (unwrapped != typeName)
        {
            // For collections, resolve the inner type
            return ResolveTypeProperties(unwrapped);
        }

        // Circular dependency protection
        if (!_visitedTypes.Add(typeName))
            return new List<Models.PropertyInfo>();

        // Try semantic model resolution first
        if (_semanticModel != null)
        {
            return ResolveViaSemanticModel(typeName);
        }

        return new List<Models.PropertyInfo>();
    }

    private List<Models.PropertyInfo> ResolveViaSemanticModel(string typeName)
    {
        var compilation = _semanticModel!.Compilation;
        var typeSymbol = compilation.GetTypeByMetadataName(typeName);

        // If not found by full name, search all types in source
        if (typeSymbol == null)
            typeSymbol = FindTypeByShortName(compilation, typeName);

        if (typeSymbol == null)
            return new List<Models.PropertyInfo>();

        return ExtractPropertiesFromSymbol(typeSymbol);
    }

    private static List<Models.PropertyInfo> ExtractPropertiesFromSymbol(INamedTypeSymbol typeSymbol)
    {
        var properties = new List<Models.PropertyInfo>();

        foreach (var member in typeSymbol.GetMembers())
        {
            if (member is not IPropertySymbol propSymbol)
                continue;

            if (propSymbol.DeclaredAccessibility != Accessibility.Public)
                continue;

            if (propSymbol.IsStatic || propSymbol.IsIndexer)
                continue;

            var propType = propSymbol.Type;
            var isNullable = propType.NullableAnnotation == NullableAnnotation.Annotated;

            // Check [Required] attribute or C# required keyword
            var hasRequiredAttr = propSymbol.GetAttributes()
                .Any(a => a.AttributeClass?.Name is "RequiredAttribute" or "Required");
            var isRequired = propSymbol.IsRequired || hasRequiredAttr;

            properties.Add(new Models.PropertyInfo
            {
                Name = ToCamelCase(propSymbol.Name),
                Type = MapRoslynTypeToJsonType(propType),
                Required = isRequired || (!isNullable && propType.IsValueType),
            });
        }

        return properties;
    }

    private static INamedTypeSymbol? FindTypeByShortName(Compilation compilation, string shortName)
    {
        foreach (var syntaxTree in compilation.SyntaxTrees)
        {
            var semanticModel = compilation.GetSemanticModel(syntaxTree);
            var root = syntaxTree.GetRoot();

            var classDecls = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
                .Where(c => c.Identifier.Text == shortName);

            foreach (var classDecl in classDecls)
            {
                var symbol = semanticModel.GetDeclaredSymbol(classDecl);
                if (symbol != null)
                    return symbol;
            }

            var recordDecls = root.DescendantNodes().OfType<RecordDeclarationSyntax>()
                .Where(r => r.Identifier.Text == shortName);

            foreach (var recordDecl in recordDecls)
            {
                var symbol = semanticModel.GetDeclaredSymbol(recordDecl);
                if (symbol != null)
                    return symbol;
            }
        }

        return null;
    }

    private static string MapRoslynTypeToJsonType(ITypeSymbol type)
    {
        var displayName = type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat)
            .TrimEnd('?');

        return displayName switch
        {
            "int" or "long" or "short" or "byte" or "Int32" or "Int64" or "Int16" or "Byte" => "integer",
            "float" or "double" or "decimal" or "Single" or "Double" or "Decimal" => "number",
            "bool" or "Boolean" => "boolean",
            "string" or "String" or "char" or "Char" => "string",
            "DateTime" or "DateTimeOffset" or "DateOnly" => "string",
            "Guid" => "string",
            _ when type.TypeKind == TypeKind.Array => "array",
            _ when IsCollectionType(type) => "array",
            _ when type.TypeKind == TypeKind.Enum => "string",
            _ => "object",
        };
    }

    private static bool IsCollectionType(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol namedType && namedType.IsGenericType)
        {
            var name = namedType.ConstructedFrom.ToDisplayString();
            return name.StartsWith("System.Collections.Generic.");
        }
        return false;
    }

    private static string MapCSharpTypeToJsonType(string typeName)
    {
        var cleanType = typeName.TrimEnd('?');
        return cleanType switch
        {
            "int" or "long" or "short" or "byte" or "Int32" or "Int64" or "Int16" or "Byte" => "integer",
            "float" or "double" or "decimal" or "Single" or "Double" or "Decimal" => "number",
            "bool" or "Boolean" => "boolean",
            "string" or "String" or "char" or "Char" or "Guid" or "DateTime"
                or "DateTimeOffset" or "DateOnly" or "TimeSpan" => "string",
            _ => "object",
        };
    }

    private static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name))
            return name;
        if (char.IsLower(name[0]))
            return name;
        return char.ToLowerInvariant(name[0]) + name[1..];
    }

    private static string? ExtractStringLiteral(ExpressionSyntax expression)
    {
        return expression switch
        {
            LiteralExpressionSyntax literal when literal.IsKind(SyntaxKind.StringLiteralExpression)
                => literal.Token.ValueText,
            InterpolatedStringExpressionSyntax => expression.ToString().Trim('"'),
            _ => expression.ToString().Trim('"'),
        };
    }

    private static string? ExtractXmlDocSummary(MethodDeclarationSyntax method)
    {
        var trivia = method.GetLeadingTrivia()
            .Select(t => t.GetStructure())
            .OfType<DocumentationCommentTriviaSyntax>()
            .FirstOrDefault();

        if (trivia == null)
            return null;

        var summaryElement = trivia.ChildNodes()
            .OfType<XmlElementSyntax>()
            .FirstOrDefault(e => e.StartTag.Name.ToString() == "summary");

        if (summaryElement == null)
            return null;

        var text = summaryElement.Content.ToString()
            .Replace("///", "")
            .Trim();

        return string.IsNullOrWhiteSpace(text) ? null : text;
    }
}
