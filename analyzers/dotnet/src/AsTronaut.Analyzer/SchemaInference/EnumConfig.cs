using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.SchemaInference;

public static class EnumConfig
{
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
                var type = semanticModel.GetTypeInfo(oce).Type
                    ?? semanticModel.GetSymbolInfo(oce.Type).Symbol as ITypeSymbol;
                if (type is null || type.TypeKind == TypeKind.Error)
                {
                    continue;
                }

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
