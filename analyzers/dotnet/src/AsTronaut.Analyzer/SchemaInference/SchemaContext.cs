using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

public sealed class SchemaContext
{
    public Dictionary<string, Schema> SharedSchemas { get; } = new();

    private readonly Dictionary<string, string> _registered = new(StringComparer.Ordinal);

    public Schema GetOrCreateReference(INamedTypeSymbol type, Func<Schema> build)
    {
        var key = StructuralKey(type);
        if (_registered.TryGetValue(key, out var existing))
        {
            return new Schema { Kind = Schema.Types.Kind.Reference, RefName = existing };
        }
        var name = AllocateName(type);
        _registered[key] = name;
        SharedSchemas[name] = new Schema { Kind = Schema.Types.Kind.Object };
        SharedSchemas[name] = build();
        return new Schema { Kind = Schema.Types.Kind.Reference, RefName = name };
    }

    private static string StructuralKey(INamedTypeSymbol type) =>
        type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);

    private string AllocateName(INamedTypeSymbol type)
    {
        var simple = type.Name;
        if (!SharedSchemas.ContainsKey(simple)) return simple;

        var qualified = simple;
        foreach (var segment in NamespaceSegmentsInnermostFirst(type))
        {
            qualified = segment + qualified;
            if (!SharedSchemas.ContainsKey(qualified)) return qualified;
        }

        var baseName = qualified;
        for (int i = 2; ; i++)
        {
            var candidate = baseName + i;
            if (!SharedSchemas.ContainsKey(candidate)) return candidate;
        }
    }

    private static IEnumerable<string> NamespaceSegmentsInnermostFirst(INamedTypeSymbol type)
    {
        for (var ns = type.ContainingNamespace; ns is { IsGlobalNamespace: false }; ns = ns.ContainingNamespace)
        {
            yield return ns.Name;
        }
    }
}
