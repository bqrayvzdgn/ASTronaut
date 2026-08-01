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
    public static bool UsesStringEnumsByDefault(Compilation compilation)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            foreach (var oce in tree.GetRoot().DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            {
                var name = oce.Type.ToString();
                // Matches JsonStringEnumConverter (System.Text.Json) and
                // StringEnumConverter (Newtonsoft.Json), with or without namespace.
                if (name.EndsWith("JsonStringEnumConverter", StringComparison.Ordinal)
                    || name.EndsWith("StringEnumConverter", StringComparison.Ordinal))
                {
                    return true;
                }
            }
        }
        return false;
    }
}
