using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.SchemaInference;

// Detects whether a compilation serializes enums as strings by default. That is
// the case when a string-enum converter is registered globally, e.g.
//   AddControllers().AddJsonOptions(o => o.JsonSerializerOptions
//       .Converters.Add(new JsonStringEnumConverter()))
//   builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions
//       .Converters.Add(new JsonStringEnumConverter()))
// System.Text.Json's own default is numeric enums, which is what we emit unless
// a global converter (here) or a per-enum [JsonConverter] (in TypeToSchema) says
// otherwise.
public static class EnumConfig
{
    // Fully-qualified names of the real converter types. Comparing resolved
    // symbols against these (instead of matching the type name textually) fixes
    // two problems with the old string scan: it now catches the .NET 8 generic
    // form JsonStringEnumConverter<TEnum> (whose type name no longer ends with
    // the plain "JsonStringEnumConverter"), and it no longer fires on unrelated
    // user types that merely share the suffix (e.g. MyJsonStringEnumConverter).
    private static readonly string[] ConverterFullNames =
    {
        "global::System.Text.Json.Serialization.JsonStringEnumConverter",
        "global::System.Text.Json.Serialization.JsonStringEnumConverter<TEnum>",
        "global::Newtonsoft.Json.Converters.StringEnumConverter",
    };

    public static bool UsesStringEnumsByDefault(Compilation compilation)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            var semanticModel = compilation.GetSemanticModel(tree);
            foreach (var oce in tree.GetRoot().DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                // Resolve the created type semantically; skip anything that does
                // not bind to a real named type (error types / missing refs).
                var type = semanticModel.GetTypeInfo(oce).Type
                    ?? semanticModel.GetSymbolInfo(oce.Type).Symbol as ITypeSymbol;
                if (type is null || type.TypeKind == TypeKind.Error)
                {
                    continue;
                }

                // OriginalDefinition collapses the constructed generic
                // JsonStringEnumConverter<TEnum> back to its open definition so
                // the FQN comparison matches the entry above.
                var fqn = type.OriginalDefinition.ToDisplayString(
                    SymbolDisplayFormat.FullyQualifiedFormat);
                if (System.Array.IndexOf(ConverterFullNames, fqn) >= 0)
                {
                    return true;
                }
            }
        }
        return false;
    }
}
