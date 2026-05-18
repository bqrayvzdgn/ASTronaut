using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Cross-route DTO dedup. Each named class type seen by TypeToSchema gets a single
// entry in SharedSchemas; subsequent encounters return a REFERENCE to that entry.
// The same instance is shared between ControllerWalker and MinimalApiWalker so a
// DTO used by both styles is hoisted exactly once.
public sealed class SchemaContext
{
    public Dictionary<string, Schema> SharedSchemas { get; } = new();

    private readonly Dictionary<INamedTypeSymbol, string> _registered =
        new(SymbolEqualityComparer.Default);

    // Returns a REFERENCE schema, lazily building the target schema via `build`
    // the first time the type is seen. Cycles are safe: a placeholder is stored
    // before `build` runs, so recursive calls during `build` short-circuit to
    // a reference instead of recursing forever.
    public Schema GetOrCreateReference(INamedTypeSymbol type, Func<Schema> build)
    {
        if (_registered.TryGetValue(type, out var existing))
        {
            return new Schema { Kind = "REFERENCE", RefName = existing };
        }
        var name = AllocateName(type.Name);
        _registered[type] = name;
        SharedSchemas[name] = new Schema { Kind = "OBJECT" }; // placeholder
        SharedSchemas[name] = build();
        return new Schema { Kind = "REFERENCE", RefName = name };
    }

    private string AllocateName(string preferred)
    {
        if (!SharedSchemas.ContainsKey(preferred)) return preferred;
        for (int i = 2; ; i++)
        {
            var candidate = preferred + i;
            if (!SharedSchemas.ContainsKey(candidate)) return candidate;
        }
    }
}
