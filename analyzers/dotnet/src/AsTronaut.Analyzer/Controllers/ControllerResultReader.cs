using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.Controllers;

// Recovers responses for actions that return IActionResult/ActionResult (no
// static payload type) by reading `return` statements in the method body:
//   return Ok(dto)          → 200 + dto schema
//   return NotFound()       → 404
//   return CreatedAtAction(..., dto) → 201 + dto schema
//   return StatusCode(422, e)        → 422 + e schema
// Only invocations of ControllerBase helpers are recognized. Returns null when
// the body yields nothing recognizable, so the caller can fall back to
// return-type inference.
public static class ControllerResultReader
{
    public static List<ResponseInfo>? TryRead(IMethodSymbol method, Compilation compilation, TypeToSchema mapper)
    {
        if (method.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is not MethodDeclarationSyntax decl)
        {
            return null;
        }
        var model = compilation.GetSemanticModel(decl.SyntaxTree);

        var exprs = new List<ExpressionSyntax>();
        if (decl.ExpressionBody?.Expression is { } arrow) exprs.Add(arrow);
        if (decl.Body is { } body)
        {
            foreach (var ret in body.DescendantNodes().OfType<ReturnStatementSyntax>())
            {
                if (ret.Expression is { } e) exprs.Add(e);
            }
        }
        if (exprs.Count == 0) return null;

        var responses = new List<ResponseInfo>();
        foreach (var expr in exprs)
        {
            var r = MapResult(expr, model, mapper);
            if (r is not null) responses.Add(r);
        }
        return responses.Count > 0 ? Dedup(responses) : null;
    }

    private static ResponseInfo? MapResult(ExpressionSyntax expr, SemanticModel model, TypeToSchema mapper)
    {
        if (expr is AwaitExpressionSyntax aw) expr = aw.Expression;
        if (expr is not InvocationExpressionSyntax inv) return null;
        if (model.GetSymbolInfo(inv).Symbol is not IMethodSymbol sym) return null;
        if (!IsControllerHelper(sym.ContainingType)) return null;
        return HttpResultConventions.Map(sym.Name, inv, model, mapper);
    }

    private static bool IsControllerHelper(INamedTypeSymbol? type)
    {
        for (var t = type; t is not null; t = t.BaseType)
        {
            if (t.Name is "ControllerBase" or "Controller") return true;
        }
        return false;
    }

    private static List<ResponseInfo> Dedup(List<ResponseInfo> responses) =>
        HttpResultConventions.Dedup(responses);
}
