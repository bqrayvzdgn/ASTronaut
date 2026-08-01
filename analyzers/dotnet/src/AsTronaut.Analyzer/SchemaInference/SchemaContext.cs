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
        var name = AllocateName(type);
        _registered[type] = name;
        SharedSchemas[name] = new Schema { Kind = "OBJECT" }; // placeholder
        SharedSchemas[name] = build();
        return new Schema { Kind = "REFERENCE", RefName = name };
    }

    // A type's simple name is used verbatim when it is unique. On a collision with
    // a DIFFERENT already-registered type, we qualify the newcomer with namespace
    // segments (innermost first) instead of an order-dependent numeric suffix, so
    // the qualified name is a stable function of the type's identity rather than of
    // how many types happened to be seen before it (e.g. `Ordering.Order` → the
    // stable `OrderingOrder`, not the positional `Order2`).
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

        // Namespace exhausted (or the global namespace) — fall back to a numeric
        // suffix on the fully-qualified base to guarantee uniqueness.
        var baseName = qualified;
        for (int i = 2; ; i++)
        {
            var candidate = baseName + i;
            if (!SharedSchemas.ContainsKey(candidate)) return candidate;
        }
    }

    // Namespace segments from innermost to outermost: `A.B.C.Order` → C, B, A.
    private static IEnumerable<string> NamespaceSegmentsInnermostFirst(INamedTypeSymbol type)
    {
        for (var ns = type.ContainingNamespace; ns is { IsGlobalNamespace: false }; ns = ns.ContainingNamespace)
        {
            yield return ns.Name;
        }
    }
}
