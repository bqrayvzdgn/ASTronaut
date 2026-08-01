using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

// Extracts AuthInfo from [Authorize] / [AllowAnonymous] attributes on a symbol
// chain (action method → declaring controller class). MVP scope: bearer JWT
// assumed unless `AuthenticationSchemes` says otherwise. AllowAnonymous wins
// over any inherited Authorize.
public static class AuthReader
{
    private const string DefaultBearerId = "bearerAuth";

    public static AuthInfo? Resolve(ISymbol method, INamedTypeSymbol? container)
    {
        // [AllowAnonymous] anywhere in the chain (method → containing class →
        // base class chain) wins over [Authorize] inherited from a base.
        if (AttributeReader.HasAttribute(method, "AllowAnonymous")) return null;
        for (var t = container; t is not null; t = t.BaseType)
        {
            if (AttributeReader.HasAttribute(t, "AllowAnonymous")) return null;
        }

        var authAttr = AttributeReader.FindAttribute(method, "Authorize");
        if (authAttr is null)
        {
            // Walk the base chain: `[Authorize]` on an abstract BaseController
            // applies to every concrete controller that derives from it.
            for (var t = container; t is not null; t = t.BaseType)
            {
                authAttr = AttributeReader.FindAttribute(t, "Authorize");
                if (authAttr is not null) break;
            }
        }
        if (authAttr is null) return null;

        var schemes = AttributeReader.GetNamedStringArg(authAttr, "AuthenticationSchemes");
        var scheme = ChooseScheme(schemes);

        // Scope/role mapping is deferred (see U10): full OpenAPI scope emission
        // needs flow metadata we can't recover from the attribute alone. But if a
        // Policy is named with no explicit scheme, fold it into the id so distinct
        // policies dedupe as distinct security schemes downstream.
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
                // The concrete header/query name isn't recoverable from
                // [Authorize] alone, so default to the common "X-API-Key" header.
                return ("apiKey", null, "X-API-Key", "header", null, "apiKeyAuth");
            case "OAuth2":
            case "OAuth":
                // Flows (authorizationCode/clientCredentials/etc.) are not
                // recoverable here; leave flow emission to the generator/deferred.
                return ("oauth2", null, null, null, null, "oauth2");
            case "OpenIdConnect":
            case "OIDC":
                return ("openIdConnect", null, null, null, null, "openIdConnect");
            default:
                // Unknown scheme: fall back to bearer but keep the id distinct.
                return ("http", "bearer", null, null, "JWT", first);
        }
    }
}
