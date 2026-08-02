using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.SchemaInference;

// The System.Text.Json property naming policies we recognize semantically. A
// compilation that assigns one of these to JsonSerializerOptions.PropertyNamingPolicy
// changes every DTO's serialized property names; the schema must follow suit.
public enum JsonNamingPolicyKind
{
    CamelCase,
    SnakeCaseLower,
    SnakeCaseUpper,
    KebabCaseLower,
    KebabCaseUpper,
    // PropertyNamingPolicy = null ⇒ property names are serialized verbatim.
    AsIs,
}

// Detects a global JsonSerializerOptions.PropertyNamingPolicy assignment, e.g.
//   AddControllers().AddJsonOptions(o => o.JsonSerializerOptions
//       .PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower)
//   builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions
//       .PropertyNamingPolicy = JsonNamingPolicy.KebabCaseUpper)
//   options.PropertyNamingPolicy = null; // as-is
// Mirrors EnumConfig: a purely semantic scan (resolved symbols, not textual name
// matching) so it catches the assignment wherever it is written and ignores
// unrelated members. Returns null when no recognized policy is configured, in
// which case naming falls back to ASP.NET Core's default camelCase — no
// regression for the common case.
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

    // True when the assignment's left-hand side binds to
    // System.Text.Json.JsonSerializerOptions.PropertyNamingPolicy.
    private static bool TargetsPropertyNamingPolicy(ExpressionSyntax left, SemanticModel model)
    {
        if (model.GetSymbolInfo(left).Symbol is not IPropertySymbol prop) return false;
        if (prop.Name != "PropertyNamingPolicy") return false;
        var owner = prop.ContainingType?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
        return owner == OptionsTypeFqn;
    }

    // Maps the right-hand side to a recognized policy kind: a static property on
    // JsonNamingPolicy (CamelCase / SnakeCaseLower / …) or a null literal (as-is).
    // A custom policy instance we cannot interpret yields null → default camelCase.
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
