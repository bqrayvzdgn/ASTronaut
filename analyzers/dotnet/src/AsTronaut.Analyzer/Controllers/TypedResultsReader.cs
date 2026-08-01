using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

// Reads Minimal API typed-result return types into ResponseInfo entries:
//   - A single typed result: Ok<T>, Created<T>, NotFound, BadRequest<T>, ...
//   - A union: Results<Ok<T>, NotFound, ...> → one response per member.
// Types live in Microsoft.AspNetCore.Http.HttpResults; the generic argument (when
// present) is the response body schema. Returns null when the return type is not
// a typed-result type, so the caller can fall back to plain return-type inference.
public static class TypedResultsReader
{
    private const string HttpResultsNs = "Microsoft.AspNetCore.Http.HttpResults";

    public static List<ResponseInfo>? TryRead(ITypeSymbol? returnType, TypeToSchema mapper)
    {
        var type = UnwrapTask(returnType);
        if (type is not INamedTypeSymbol named) return null;
        if (named.ContainingNamespace?.ToDisplayString() != HttpResultsNs) return null;

        // Results<T1, T2, ...> union.
        if (named.Name == "Results" && named.IsGenericType)
        {
            var responses = new List<ResponseInfo>();
            foreach (var arg in named.TypeArguments)
            {
                var r = MapOne(arg, mapper);
                if (r is not null) responses.Add(r);
            }
            return responses.Count > 0 ? Dedup(responses) : null;
        }

        // Single typed result.
        var single = MapOne(named, mapper);
        return single is null ? null : new List<ResponseInfo> { single };
    }

    private static ResponseInfo? MapOne(ITypeSymbol type, TypeToSchema mapper)
    {
        if (type is not INamedTypeSymbol n) return null;
        if (n.ContainingNamespace?.ToDisplayString() != HttpResultsNs) return null;

        var status = StatusFor(n.Name);
        if (status is null) return null;

        var response = new ResponseInfo
        {
            Status = status.Value,
            Description = ResponseTypeReader.DescribeStatusPublic(status.Value),
        };

        // File results carry a binary payload rather than a JSON body.
        if (IsFileResult(n.Name))
        {
            return response with { Schema = BinarySchema(), ContentType = "application/octet-stream" };
        }

        // Generic results (Ok<T>, JsonHttpResult<T>, CreatedAtRoute<T>, ...) expose
        // the response body as their first type argument.
        if (n.IsGenericType && n.TypeArguments.Length >= 1)
        {
            response = response with
            {
                Schema = mapper.Map(n.TypeArguments[0]),
                ContentType = "application/json",
            };
        }
        return response;
    }

    private static int? StatusFor(string typeName) => typeName switch
    {
        "Ok" => 200,
        "Created" or "CreatedAtRoute" => 201,
        "Accepted" or "AcceptedAtRoute" => 202,
        "NoContent" or "EmptyHttpResult" => 204,
        "BadRequest" or "ValidationProblem" => 400,
        "UnauthorizedHttpResult" => 401,
        "ForbidHttpResult" => 403,
        "NotFound" => 404,
        "Conflict" => 409,
        "UnprocessableEntity" => 422,
        "ProblemHttpResult" => 500,
        // JsonHttpResult<T> carries a JSON body (via its generic argument);
        // ContentHttpResult writes text but exposes no typed body.
        "JsonHttpResult" or "ContentHttpResult" => 200,
        // File downloads → 200 with a binary body (handled in MapOne).
        "FileContentHttpResult" or "FileStreamHttpResult" or "PhysicalFileHttpResult" => 200,
        "RedirectHttpResult" => 302,
        "ChallengeHttpResult" => 401,
        // Auth sign-in/out results carry no body.
        "SignInHttpResult" => 200,
        "SignOutHttpResult" => 204,
        _ => null,
    };

    private static bool IsFileResult(string typeName) => typeName is
        "FileContentHttpResult" or "FileStreamHttpResult" or "PhysicalFileHttpResult";

    // A binary payload schema, matching how IFormFile bodies are represented.
    private static Schema BinarySchema() =>
        new() { Kind = "PRIMITIVE", PrimitiveType = "string", Format = "binary" };

    // Collapse duplicate status codes (e.g. two 200s), preferring an entry that
    // carries a body schema.
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

    private static ITypeSymbol? UnwrapTask(ITypeSymbol? type)
    {
        if (type is INamedTypeSymbol named && named.IsGenericType && named.TypeArguments.Length == 1)
        {
            var def = named.ConstructedFrom.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            if (def is "global::System.Threading.Tasks.Task<TResult>"
                or "global::System.Threading.Tasks.ValueTask<TResult>")
            {
                return named.TypeArguments[0];
            }
        }
        return type;
    }
}
