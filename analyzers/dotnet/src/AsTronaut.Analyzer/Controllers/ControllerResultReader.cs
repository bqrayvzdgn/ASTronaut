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

        var status = StatusFor(sym.Name, inv, model);
        if (status is null) return null;

        var response = new ResponseInfo
        {
            Status = status.Value,
            Description = ResponseTypeReader.DescribeStatusPublic(status.Value),
        };
        var valueType = ValueType(sym.Name, inv, model);
        if (valueType is not null && valueType.SpecialType != SpecialType.System_Void)
        {
            response = response with { Schema = mapper.Map(valueType), ContentType = "application/json" };
        }
        return response;
    }

    private static int? StatusFor(string helper, InvocationExpressionSyntax inv, SemanticModel model) => helper switch
    {
        "Ok" => 200,
        "Created" or "CreatedAtAction" or "CreatedAtRoute" => 201,
        "Accepted" or "AcceptedAtAction" or "AcceptedAtRoute" => 202,
        "NoContent" => 204,
        "BadRequest" or "ValidationProblem" => 400,
        "Unauthorized" => 401,
        "Forbid" => 403,
        "NotFound" => 404,
        "Conflict" => 409,
        "UnprocessableEntity" => 422,
        "Problem" => 500,
        "StatusCode" => ReadStatusCodeArg(inv, model),
        _ => null,
    };

    private static int? ReadStatusCodeArg(InvocationExpressionSyntax inv, SemanticModel model)
    {
        var first = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
        if (first is null) return null;
        // Resolves both literals (422) and constants (StatusCodes.Status422...).
        return model.GetConstantValue(first) is { HasValue: true, Value: int code } ? code : null;
    }

    // The argument that carries the response body, per helper. String args
    // (route names / messages) are treated as non-bodies.
    private static ITypeSymbol? ValueType(string helper, InvocationExpressionSyntax inv, SemanticModel model)
    {
        var args = inv.ArgumentList.Arguments;
        ExpressionSyntax? valueArg = helper switch
        {
            "Ok" or "NotFound" or "BadRequest" or "Conflict" or "UnprocessableEntity"
                => args.Count >= 1 ? args[0].Expression : null,
            "Created" or "CreatedAtAction" or "CreatedAtRoute"
            or "Accepted" or "AcceptedAtAction" or "AcceptedAtRoute"
                => args.Count >= 1 ? args[^1].Expression : null,
            "StatusCode" => args.Count >= 2 ? args[1].Expression : null,
            _ => null,
        };
        if (valueArg is null) return null;
        var type = model.GetTypeInfo(valueArg).Type;
        if (type is null || type.SpecialType == SpecialType.System_String) return null;
        return type;
    }

    private static bool IsControllerHelper(INamedTypeSymbol? type)
    {
        for (var t = type; t is not null; t = t.BaseType)
        {
            if (t.Name is "ControllerBase" or "Controller") return true;
        }
        return false;
    }

    private static List<ResponseInfo> Dedup(List<ResponseInfo> responses)
    {
        var byStatus = new Dictionary<int, ResponseInfo>();
        foreach (var r in responses)
        {
            if (byStatus.TryGetValue(r.Status, out var existing))
            {
                if (existing.Schema is null && r.Schema is not null) byStatus[r.Status] = r;
            }
            else
            {
                byStatus[r.Status] = r;
            }
        }
        return byStatus.Values.OrderBy(r => r.Status).ToList();
    }
}
