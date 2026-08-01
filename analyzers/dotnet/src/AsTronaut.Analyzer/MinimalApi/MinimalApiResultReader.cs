using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.MinimalApi;

// Recovers responses for minimal API handlers that return `IResult` via
// `Results.Ok(dto)` / `TypedResults.Ok(dto)` / `Results.NotFound()` etc. — the
// return type carries no payload, so the handler body is inspected (lambda body
// or the referenced method's returns). Returns null when nothing is recognized.
public static class MinimalApiResultReader
{
    public static List<ResponseInfo>? TryRead(
        ExpressionSyntax handler,
        IMethodSymbol? handlerMethod,
        SemanticModel handlerModel,
        Compilation compilation,
        TypeToSchema mapper)
    {
        var (body, model) = ResolveBody(handler, handlerMethod, handlerModel, compilation);
        if (body is null) return null;

        // Every Results.X(...) / TypedResults.X(...) call anywhere in the body —
        // covers ternaries, switch expressions and multiple return statements.
        var responses = new List<ResponseInfo>();
        foreach (var inv in body.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>())
        {
            if (model.GetSymbolInfo(inv).Symbol is not IMethodSymbol sym) continue;
            if (!IsResultsHelper(sym.ContainingType)) continue;
            var r = HttpResultConventions.Map(sym.Name, inv, model, mapper);
            if (r is not null) responses.Add(r);
        }
        return responses.Count > 0 ? HttpResultConventions.Dedup(responses) : null;
    }

    // The handler body to search, with the right semantic model. Lambdas use the
    // caller's model; a method/local-function reference uses its own tree's.
    private static (SyntaxNode? Body, SemanticModel Model) ResolveBody(
        ExpressionSyntax handler, IMethodSymbol? handlerMethod, SemanticModel handlerModel, Compilation compilation)
    {
        if (handler is LambdaExpressionSyntax lambda)
        {
            return (lambda.Body, handlerModel);
        }
        var syntax = handlerMethod?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
        SyntaxNode? body = syntax switch
        {
            MethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody?.Expression,
            LocalFunctionStatementSyntax lf => (SyntaxNode?)lf.Body ?? lf.ExpressionBody?.Expression,
            _ => null,
        };
        return body is null ? (null, handlerModel) : (body, compilation.GetSemanticModel(syntax!.SyntaxTree));
    }

    // Static Results / TypedResults factories in Microsoft.AspNetCore.Http.
    private static bool IsResultsHelper(INamedTypeSymbol? type) =>
        type?.ContainingNamespace?.ToDisplayString() == "Microsoft.AspNetCore.Http"
        && type.Name is "Results" or "TypedResults";
}
