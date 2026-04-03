using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using AutoDocAnalyzer.Models;

namespace AutoDocAnalyzer.Parsers;

public class MinimalApiParser
{
    private static readonly Dictionary<string, string> MapMethodNames = new()
    {
        { "MapGet", "GET" },
        { "MapPost", "POST" },
        { "MapPut", "PUT" },
        { "MapDelete", "DELETE" },
        { "MapPatch", "PATCH" },
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
        { "FromServices", "service" },
        { "FromServicesAttribute", "service" },
    };

    private readonly SemanticModel? _semanticModel;
    private readonly HashSet<string> _visitedTypes = new();

    public MinimalApiParser(SemanticModel? semanticModel)
    {
        _semanticModel = semanticModel;
    }

    public List<RouteInfo> Parse(SyntaxTree tree, string filePath)
    {
        var routes = new List<RouteInfo>();
        var root = tree.GetCompilationUnitRoot();

        var invocations = root.DescendantNodes().OfType<InvocationExpressionSyntax>();

        foreach (var invocation in invocations)
        {
            if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
                continue;

            var methodName = memberAccess.Name.Identifier.Text;
            if (!MapMethodNames.TryGetValue(methodName, out var httpMethod))
                continue;

            var args = invocation.ArgumentList.Arguments;
            if (args.Count < 2)
                continue;

            // First argument is the route path
            var routePath = ExtractStringLiteral(args[0].Expression);
            if (routePath == null)
                continue;

            // Ensure path starts with /
            if (!routePath.StartsWith("/"))
                routePath = "/" + routePath;

            // Strip route constraints: {id:guid} → {id}
            routePath = Regex.Replace(routePath, @"\{(\w+):[^}]+\}", "{$1}");

            var route = new RouteInfo
            {
                Path = routePath,
                Method = httpMethod,
                Controller = null,
                RoutePrefix = null,
                Source = filePath,
            };

            // Second argument is typically a lambda or method group
            var handler = args[1].Expression;
            ExtractHandlerInfo(handler, route);

            // Check for chained calls like .RequireAuthorization(), .WithName(), etc.
            ExtractChainedCalls(invocation, route);

            routes.Add(route);
        }

        return routes;
    }

    private void ExtractHandlerInfo(ExpressionSyntax handler, RouteInfo route)
    {
        switch (handler)
        {
            case ParenthesizedLambdaExpressionSyntax lambda:
                ExtractLambdaParams(lambda.ParameterList, route);
                ExtractLambdaReturnType(lambda, route);
                break;

            case SimpleLambdaExpressionSyntax simpleLambda:
                ExtractSimpleLambdaParam(simpleLambda.Parameter, route);
                break;

            case IdentifierNameSyntax or MemberAccessExpressionSyntax:
                // Method group reference - try semantic model
                if (_semanticModel != null)
                {
                    ExtractMethodGroupInfo(handler, route);
                }
                break;
        }
    }

    private static readonly HashSet<string> FormFileTypes = new()
    {
        "IFormFile", "IFormFileCollection", "IFormFile?",
        "List<IFormFile>", "IList<IFormFile>", "IEnumerable<IFormFile>",
    };

    private void ExtractLambdaParams(ParameterListSyntax parameterList, RouteInfo route)
    {
        foreach (var param in parameterList.Parameters)
        {
            var paramName = param.Identifier.Text;
            var paramType = param.Type?.ToString() ?? "object";
            var source = DetermineParamSource(param, route.Path);

            // Skip service-injected parameters
            if (source == "service")
                continue;

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
                var properties = ResolveTypePropertiesFromSyntax(param.Type);
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

    private List<Models.PropertyInfo> ResolveTypePropertiesFromSyntax(TypeSyntax? typeSyntax)
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

    private void ExtractSimpleLambdaParam(ParameterSyntax param, RouteInfo route)
    {
        var paramName = param.Identifier.Text;
        var paramType = param.Type?.ToString() ?? "object";

        if (route.Path.Contains($"{{{paramName}}}"))
        {
            route.Params.Add(new ParamInfo
            {
                Name = paramName,
                In = "path",
                Type = MapCSharpTypeToJsonType(paramType),
                Required = true,
            });
        }
        else
        {
            route.Params.Add(new ParamInfo
            {
                Name = paramName,
                In = "query",
                Type = MapCSharpTypeToJsonType(paramType),
                Required = param.Default == null && !paramType.EndsWith("?"),
            });
        }
    }

    private void ExtractLambdaReturnType(ParenthesizedLambdaExpressionSyntax lambda, RouteInfo route)
    {
        // Check explicit return type annotation
        if (lambda.ReturnType != null)
        {
            var returnTypeName = lambda.ReturnType.ToString();
            returnTypeName = UnwrapGenericType(returnTypeName, "Task");
            returnTypeName = UnwrapGenericType(returnTypeName, "ValueTask");

            if (returnTypeName != "void" && returnTypeName != "IResult")
            {
                _visitedTypes.Clear();
                route.Responses.Add(new ResponseInfo
                {
                    Status = route.Method == "POST" ? 201 : 200,
                    Type = returnTypeName,
                    Properties = ResolveTypeProperties(returnTypeName),
                });
                return;
            }
        }

        // Try to infer from Results.Ok<T>() or TypedResults.Ok<T>()
        var returnStatements = lambda.DescendantNodes().OfType<ReturnStatementSyntax>();
        foreach (var returnStatement in returnStatements)
        {
            if (returnStatement.Expression is InvocationExpressionSyntax returnInvocation)
            {
                var resultInfo = ExtractTypedResultInfo(returnInvocation);
                if (resultInfo != null)
                {
                    route.Responses.Add(resultInfo);
                    return;
                }
            }
        }

        // Default response
        route.Responses.Add(new ResponseInfo
        {
            Status = route.Method == "POST" ? 201 : 200,
            Type = null,
            Properties = new List<Models.PropertyInfo>(),
        });
    }

    private ResponseInfo? ExtractTypedResultInfo(InvocationExpressionSyntax invocation)
    {
        if (invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
            return null;

        var callerName = memberAccess.Expression.ToString();
        var methodName = memberAccess.Name.ToString();

        if (callerName is not ("Results" or "TypedResults"))
            return null;

        var status = methodName switch
        {
            "Ok" => 200,
            "Created" => 201,
            "NoContent" => 204,
            "BadRequest" => 400,
            "NotFound" => 404,
            "Conflict" => 409,
            _ => 200,
        };

        // Check for generic type argument: Results.Ok<MyType>(...)
        string? typeName = null;
        var properties = new List<Models.PropertyInfo>();

        if (memberAccess.Name is GenericNameSyntax genericName &&
            genericName.TypeArgumentList.Arguments.Count > 0)
        {
            typeName = genericName.TypeArgumentList.Arguments[0].ToString();
            _visitedTypes.Clear();
            properties = ResolveTypeProperties(typeName);
        }

        return new ResponseInfo
        {
            Status = status,
            Type = typeName,
            Properties = properties,
        };
    }

    private void ExtractMethodGroupInfo(ExpressionSyntax handler, RouteInfo route)
    {
        var symbolInfo = _semanticModel!.GetSymbolInfo(handler);
        if (symbolInfo.Symbol is not IMethodSymbol methodSymbol)
            return;

        foreach (var param in methodSymbol.Parameters)
        {
            var source = DetermineParamSourceFromSymbol(param, route.Path);

            if (source == "service")
                continue;

            var paramType = param.Type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);

            if (source == "body")
            {
                _visitedTypes.Clear();
                route.RequestBody = new RequestBodyInfo
                {
                    Type = paramType,
                    Properties = ResolveTypeProperties(paramType),
                };
                continue;
            }

            route.Params.Add(new ParamInfo
            {
                Name = param.Name,
                In = source,
                Type = MapCSharpTypeToJsonType(paramType),
                Required = !param.IsOptional && param.Type.NullableAnnotation != NullableAnnotation.Annotated,
            });
        }

        // Return type
        var returnType = methodSymbol.ReturnType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        returnType = UnwrapGenericType(returnType, "Task");
        returnType = UnwrapGenericType(returnType, "ValueTask");

        if (returnType != "void" && returnType != "IResult")
        {
            _visitedTypes.Clear();
            route.Responses.Add(new ResponseInfo
            {
                Status = route.Method == "POST" ? 201 : 200,
                Type = returnType,
                Properties = ResolveTypeProperties(returnType),
            });
        }
        else
        {
            route.Responses.Add(new ResponseInfo
            {
                Status = route.Method == "POST" ? 201 : 200,
                Type = null,
                Properties = new List<Models.PropertyInfo>(),
            });
        }
    }

    private static void ExtractChainedCalls(InvocationExpressionSyntax invocation, RouteInfo route)
    {
        // Walk up the expression tree to find chained method calls
        var current = invocation.Parent;
        while (current != null)
        {
            if (current is MemberAccessExpressionSyntax chainedAccess &&
                current.Parent is InvocationExpressionSyntax chainedInvocation)
            {
                var chainedMethodName = chainedAccess.Name.Identifier.Text;

                switch (chainedMethodName)
                {
                    case "RequireAuthorization":
                        route.Auth = ExtractAuthPolicy(chainedInvocation) ?? "Bearer";
                        break;

                    case "WithName":
                        // Could extract operation name if needed
                        break;

                    case "WithDescription":
                        if (chainedInvocation.ArgumentList.Arguments.Count > 0)
                        {
                            route.Description = ExtractStringLiteral(
                                chainedInvocation.ArgumentList.Arguments[0].Expression);
                        }
                        break;

                    case "WithTags":
                        // Could extract tags if needed
                        break;

                    case "AllowAnonymous":
                        route.Auth = null;
                        break;
                }

                current = chainedInvocation.Parent;
            }
            else
            {
                break;
            }
        }
    }

    private static string? ExtractAuthPolicy(InvocationExpressionSyntax invocation)
    {
        if (invocation.ArgumentList.Arguments.Count > 0)
        {
            return ExtractStringLiteral(invocation.ArgumentList.Arguments[0].Expression);
        }

        return null;
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

        var paramName = param.Identifier.Text;
        if (routePath.Contains($"{{{paramName}}}") || routePath.Contains($"{{{paramName}:"))
            return "path";

        var typeName = param.Type?.ToString() ?? "";
        if (IsServiceType(typeName))
            return "service";

        if (!IsPrimitiveType(typeName))
            return "body";

        return "query";
    }

    private static string DetermineParamSourceFromSymbol(IParameterSymbol param, string routePath)
    {
        foreach (var attr in param.GetAttributes())
        {
            var attrName = attr.AttributeClass?.Name ?? "";
            if (ParamSourceAttributes.TryGetValue(attrName, out var source))
                return source;
        }

        if (routePath.Contains($"{{{param.Name}}}") || routePath.Contains($"{{{param.Name}:"))
            return "path";

        if (IsServiceTypeSymbol(param.Type))
            return "service";

        if (!IsPrimitiveTypeSymbol(param.Type))
            return "body";

        return "query";
    }

    private static bool IsServiceType(string typeName)
    {
        return typeName.StartsWith("I") && typeName.Length > 1 && char.IsUpper(typeName[1])
               && !typeName.StartsWith("Int");
    }

    private static bool IsServiceTypeSymbol(ITypeSymbol type)
    {
        return type.TypeKind == TypeKind.Interface;
    }

    private static bool IsPrimitiveType(string typeName)
    {
        var cleanType = typeName.TrimEnd('?');
        return cleanType switch
        {
            "int" or "long" or "short" or "byte" or "float" or "double" or "decimal"
                or "bool" or "string" or "char" or "Guid" or "DateTime" or "DateTimeOffset"
                or "TimeSpan" or "Int32" or "Int64" or "Int16" or "Byte" or "Single"
                or "Double" or "Decimal" or "Boolean" or "String" or "Char"
                or "CancellationToken" => true,
            _ => false,
        };
    }

    private static bool IsPrimitiveTypeSymbol(ITypeSymbol type)
    {
        return type.SpecialType != SpecialType.None || type.TypeKind == TypeKind.Enum;
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
            return ResolveTypeProperties(unwrapped);

        // Circular dependency protection
        if (!_visitedTypes.Add(typeName))
            return new List<Models.PropertyInfo>();

        if (_semanticModel == null)
            return new List<Models.PropertyInfo>();

        return ResolveViaSemanticModel(typeName);
    }

    private List<Models.PropertyInfo> ResolveViaSemanticModel(string typeName)
    {
        var compilation = _semanticModel!.Compilation;
        var typeSymbol = compilation.GetTypeByMetadataName(typeName);

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

    private static string UnwrapGenericType(string typeName, string wrapperName)
    {
        if (typeName.StartsWith(wrapperName + "<") && typeName.EndsWith(">"))
            return typeName[(wrapperName.Length + 1)..^1];
        return typeName;
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
}
