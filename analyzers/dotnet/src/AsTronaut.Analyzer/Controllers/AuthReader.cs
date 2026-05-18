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
        var info = new AuthInfo
        {
            Type = scheme.Type,
            Scheme = scheme.Scheme,
            BearerFormat = scheme.BearerFormat,
            Id = scheme.Id,
        };
        return info;
    }

    private static (string Type, string? Scheme, string? BearerFormat, string Id) ChooseScheme(
        string? schemes)
    {
        if (string.IsNullOrWhiteSpace(schemes))
        {
            return ("http", "bearer", "JWT", DefaultBearerId);
        }
        var first = schemes.Split(',', ';')[0].Trim();
        switch (first)
        {
            case "Bearer":
            case "JwtBearer":
                return ("http", "bearer", "JWT", DefaultBearerId);
            case "Basic":
                return ("http", "basic", null, "basicAuth");
            default:
                // Unknown scheme: fall back to bearer but keep the id distinct.
                return ("http", "bearer", "JWT", first);
        }
    }
}
