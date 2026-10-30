using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AsTronaut.Analyzer.Controllers;

public static class HttpResultConventions
{
    public static ResponseInfo? Map(
        string helper, InvocationExpressionSyntax inv, SemanticModel model, TypeToSchema mapper)
    {
        var status = StatusFor(helper, inv, model);
        if (status is null) return null;

        var response = new ResponseInfo
        {
            Status = status.Value,
            Description = ResponseTypeReader.DescribeStatusPublic(status.Value),
        };

        if (IsFileHelper(helper))
        {
            return response with { Schema = BinarySchema(), ContentType = "application/octet-stream" };
        }
        if (helper == "Content")
        {
            return response with { ContentType = "text/plain" };
        }

        var valueType = ValueType(helper, inv, model);
        if (valueType is not null && valueType.SpecialType != SpecialType.System_Void)
        {
            response = response with { Schema = mapper.Map(valueType), ContentType = "application/json" };
        }
        return response;
    }

    public static List<ResponseInfo> Dedup(List<ResponseInfo> responses)
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
        "File" or "PhysicalFile" or "FileStreamResult" or "FileContentResult" => 200,
        "Redirect" or "LocalRedirect" => 302,
        "RedirectPermanent" or "LocalRedirectPermanent" => 301,
        "Json" or "Content" => 200,
        "StatusCode" => ReadStatusCodeArg(inv, model),
        _ => null,
    };

    private static bool IsFileHelper(string helper) => helper is
        "File" or "PhysicalFile" or "FileStreamResult" or "FileContentResult";

    private static Schema BinarySchema() =>
        new() { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "binary" };

    private static int? ReadStatusCodeArg(InvocationExpressionSyntax inv, SemanticModel model)
    {
        var first = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
        if (first is null) return null;
        return model.GetConstantValue(first) is { HasValue: true, Value: int code } ? code : null;
    }

    private static ITypeSymbol? ValueType(string helper, InvocationExpressionSyntax inv, SemanticModel model)
    {
        var args = inv.ArgumentList.Arguments;
        ExpressionSyntax? valueArg = helper switch
        {
            "Ok" or "Json" or "NotFound" or "BadRequest" or "Conflict" or "UnprocessableEntity"
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
}
