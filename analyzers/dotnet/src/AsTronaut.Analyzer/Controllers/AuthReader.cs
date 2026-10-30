using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

public static class AuthReader
{
    private const string DefaultBearerId = "bearerAuth";

    public static AuthInfo? Resolve(ISymbol method, INamedTypeSymbol? container)
    {
        if (AttributeReader.HasAttribute(method, "AllowAnonymous")) return null;
        for (var t = container; t is not null; t = t.BaseType)
        {
            if (AttributeReader.HasAttribute(t, "AllowAnonymous")) return null;
        }

        var authAttr = AttributeReader.FindAttribute(method, "Authorize");
        if (authAttr is null)
        {
            for (var t = container; t is not null; t = t.BaseType)
            {
                authAttr = AttributeReader.FindAttribute(t, "Authorize");
                if (authAttr is not null) break;
            }
        }
        if (authAttr is null) return null;

        var schemes = AttributeReader.GetNamedStringArg(authAttr, "AuthenticationSchemes");
        var scheme = ChooseScheme(schemes);

        var id = scheme.Id;
        if (string.IsNullOrWhiteSpace(schemes))
        {
            var policy = AttributeReader.GetNamedStringArg(authAttr, "Policy");
            if (!string.IsNullOrWhiteSpace(policy))
            {
                id = $"{scheme.Id}:{policy!.Trim()}";
            }
        }

        var info = new AuthInfo
        {
            Type = scheme.Type,
            Scheme = scheme.Scheme,
            Name = scheme.Name,
            In = scheme.In,
            BearerFormat = scheme.BearerFormat,
            Id = id,
        };
        return info;
    }

    private static (string Type, string? Scheme, string? Name, string? In, string? BearerFormat, string Id) ChooseScheme(
        string? schemes)
    {
        if (string.IsNullOrWhiteSpace(schemes))
        {
            return ("http", "bearer", null, null, "JWT", DefaultBearerId);
        }
        var first = schemes.Split(',', ';')[0].Trim();
        switch (first)
        {
            case "Bearer":
            case "JwtBearer":
                return ("http", "bearer", null, null, "JWT", DefaultBearerId);
            case "Basic":
                return ("http", "basic", null, null, null, "basicAuth");
            case "ApiKey":
            case "ApiKeyScheme":
                return ("apiKey", null, "X-API-Key", "header", null, "apiKeyAuth");
            case "OAuth2":
            case "OAuth":
                return ("oauth2", null, null, null, null, "oauth2");
            case "OpenIdConnect":
            case "OIDC":
                return ("openIdConnect", null, null, null, null, "openIdConnect");
            default:
                return ("http", "bearer", null, null, "JWT", first);
        }
    }
}
