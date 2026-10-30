using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.SchemaInference;

public enum JsonNamingPolicyKind
{
    CamelCase,
    SnakeCaseLower,
    SnakeCaseUpper,
    KebabCaseLower,
    KebabCaseUpper,
    AsIs,
}

public static class NamingPolicyConfig
{
    private const string OptionsTypeFqn = "global::System.Text.Json.JsonSerializerOptions";
    private const string PolicyTypeFqn = "global::System.Text.Json.JsonNamingPolicy";

    public static JsonNamingPolicyKind? Detect(Compilation compilation)
    {
        foreach (var tree in compilation.SyntaxTrees)
        {
            var model = compilation.GetSemanticModel(tree);
            foreach (var assign in tree.GetRoot().DescendantNodes()
                         .OfType<AssignmentExpressionSyntax>())
            {
                if (!assign.IsKind(SyntaxKind.SimpleAssignmentExpression)) continue;
                if (!TargetsPropertyNamingPolicy(assign.Left, model)) continue;

                var kind = ResolvePolicyKind(assign.Right, model);
                if (kind is not null) return kind;
            }
        }
        return null;
    }

    private static bool TargetsPropertyNamingPolicy(ExpressionSyntax left, SemanticModel model)
    {
        if (model.GetSymbolInfo(left).Symbol is not IPropertySymbol prop) return false;
        if (prop.Name != "PropertyNamingPolicy") return false;
        var owner = prop.ContainingType?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return owner == OptionsTypeFqn;
    }

    private static JsonNamingPolicyKind? ResolvePolicyKind(ExpressionSyntax right, SemanticModel model)
    {
        if (right.IsKind(SyntaxKind.NullLiteralExpression))
        {
            return JsonNamingPolicyKind.AsIs;
        }

        if (model.GetSymbolInfo(right).Symbol is IPropertySymbol prop)
        {
            var owner = prop.ContainingType?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            if (owner == PolicyTypeFqn)
            {
                return prop.Name switch
                {
                    "CamelCase" => JsonNamingPolicyKind.CamelCase,
                    "SnakeCaseLower" => JsonNamingPolicyKind.SnakeCaseLower,
                    "SnakeCaseUpper" => JsonNamingPolicyKind.SnakeCaseUpper,
                    "KebabCaseLower" => JsonNamingPolicyKind.KebabCaseLower,
                    "KebabCaseUpper" => JsonNamingPolicyKind.KebabCaseUpper,
                    _ => (JsonNamingPolicyKind?)null,
                };
            }
        }

        return null;
    }
}
