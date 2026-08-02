using AsTronaut.Analyzer.Ir;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.SchemaInference;

// Cross-route DTO dedup. Each named class type seen by TypeToSchema gets a single
// entry in SharedSchemas; subsequent encounters return a REFERENCE to that entry.
// One instance is shared across every project's ControllerWalker so a DTO used by
// more than one project is hoisted exactly once.
public sealed class SchemaContext
{
    public Dictionary<string, Schema> SharedSchemas { get; } = new();

    // Dedup key is the type's STRUCTURAL identity (see StructuralKey), not its
    // symbol. Symbol identity (SymbolEqualityComparer) is per-compilation, so in a
    // multi-project `.sln` the same DTO reached through a metadata reference is a
    // different symbol than the project that owns its source — symbol-keyed dedup
    // misses and AllocateName's collision path emits a duplicated, namespace-
    // qualified second copy. A fully-qualified-name key is stable across
    // compilations, so the DTO is hoisted exactly once. (R2/R6)
    private readonly Dictionary<string, string> _registered = new(StringComparer.Ordinal);

    // Returns a REFERENCE schema, lazily building the target schema via `build`
    // the first time the type is seen. Cycles are safe: a placeholder is stored
    // before `build` runs, so recursive calls during `build` short-circuit to
    // a reference instead of recursing forever.
    public Schema GetOrCreateReference(INamedTypeSymbol type, Func<Schema> build)
    {
        var key = StructuralKey(type);
        if (_registered.TryGetValue(key, out var existing))
        {
            return new Schema { Kind = "REFERENCE", RefName = existing };
        }
        var name = AllocateName(type);
        _registered[key] = name;
        SharedSchemas[name] = new Schema { Kind = "OBJECT" }; // placeholder
        SharedSchemas[name] = build();
        return new Schema { Kind = "REFERENCE", RefName = name };
    }

    // Structural dedup key: the fully-qualified name including namespace and, for
    // constructed generics, the type arguments (e.g. `global::Demo.Order`,
    // `global::Demo.Page<global::Demo.Item>`). Because it carries the namespace,
    // two genuinely different types that share a simple name (`Ordering.Order` vs
    // `Shipping.Order`) still get distinct keys and stay separate schemas, while
    // the SAME closed generic used twice collapses to one. This string is stable
    // across compilations, unlike symbol identity.
    private static string StructuralKey(INamedTypeSymbol type) =>
        type.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);

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
