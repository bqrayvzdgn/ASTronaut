using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

// Helpers for reading ASP.NET attribute metadata via Roslyn symbols. Attributes
// are matched by their type name (with or without the "Attribute" suffix) so
// shorthand forms ([HttpGet]) and full forms ([HttpGetAttribute]) both work.
public static class AttributeReader
{
    public static bool HasAttribute(ISymbol symbol, string name)
    {
        foreach (var attr in symbol.GetAttributes())
        {
            if (Matches(attr.AttributeClass, name)) return true;
        }
        return false;
    }

    public static AttributeData? FindAttribute(ISymbol symbol, params string[] names)
    {
        foreach (var attr in symbol.GetAttributes())
        {
            foreach (var name in names)
            {
                if (Matches(attr.AttributeClass, name)) return attr;
            }
        }
        return null;
    }

    public static IEnumerable<AttributeData> FindAttributes(ISymbol symbol, params string[] names)
    {
        foreach (var attr in symbol.GetAttributes())
        {
            foreach (var name in names)
            {
                if (Matches(attr.AttributeClass, name))
                {
                    yield return attr;
                    break;
                }
            }
        }
    }

    public static string? GetStringArg(AttributeData attribute, int index = 0)
    {
        if (index < attribute.ConstructorArguments.Length)
        {
            var arg = attribute.ConstructorArguments[index];
            if (arg.Value is string s) return s;
        }
        return null;
    }

    public static string? GetNamedStringArg(AttributeData attribute, string name)
    {
        foreach (var na in attribute.NamedArguments)
        {
            if (na.Key == name && na.Value.Value is string s) return s;
        }
        return null;
    }

    private static bool Matches(INamedTypeSymbol? cls, string name)
    {
        if (cls is null) return false;
        var n = cls.Name;
        if (n == name) return true;
        if (n == name + "Attribute") return true;
        if (n.EndsWith("Attribute", StringComparison.Ordinal)
            && n.Substring(0, n.Length - 9) == name) return true;
        return false;
    }
}
