using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;

namespace AsTronaut.Analyzer.Controllers;

// Reads `[ProducesResponseType]`, `[ProducesResponseType<T>]`, and
// `[ProducesDefaultResponseType]` attributes to produce ResponseInfo entries.
// Supported attribute shapes:
//   [ProducesResponseType(typeof(Foo), StatusCodes.Status200OK)]
//   [ProducesResponseType(StatusCodes.Status404NotFound)]
//   [ProducesResponseType<Foo>(200)]
//   [ProducesResponseType(typeof(Foo), Type = typeof(Bar), StatusCode = 200)]
public static class ResponseTypeReader
{
    public static List<ResponseInfo> Read(ISymbol method, TypeToSchema mapper)
    {
        var responses = new List<ResponseInfo>();
        foreach (var attr in method.GetAttributes())
        {
            var cls = attr.AttributeClass;
            if (cls is null) continue;
            var name = StripAttrSuffix(cls.Name);

            if (name == "ProducesDefaultResponseType")
            {
                var schema = ReadTypeArg(attr, cls, mapper);
                responses.Add(new ResponseInfo
                {
                    Status = 200,
                    Description = "Default",
                    Schema = schema,
                    ContentType = schema is null ? null : "application/json",
                });
                continue;
            }
            if (name != "ProducesResponseType") continue;

            var status = ReadStatusCode(attr);
            var statusSchema = ReadTypeArg(attr, cls, mapper);
            responses.Add(new ResponseInfo
            {
                Status = status,
                Description = DescribeStatus(status),
                Schema = statusSchema,
                ContentType = statusSchema is null ? null : "application/json",
            });
        }
        return responses;
    }

    private static int ReadStatusCode(AttributeData attr)
    {
        // Positional int arg in any slot.
        foreach (var arg in attr.ConstructorArguments)
        {
            if (arg.Value is int i) return i;
        }
        foreach (var na in attr.NamedArguments)
        {
            if (na.Key == "StatusCode" && na.Value.Value is int i) return i;
        }
        return 200;
    }

    private static Schema? ReadTypeArg(AttributeData attr, INamedTypeSymbol attrClass, TypeToSchema mapper)
    {
        // Generic form: ProducesResponseType<T>
        if (attrClass.IsGenericType && attrClass.TypeArguments.Length >= 1)
        {
            return mapper.Map(attrClass.TypeArguments[0]);
        }
        // Positional typeof(T) arg.
        foreach (var arg in attr.ConstructorArguments)
        {
            if (arg.Value is ITypeSymbol t) return mapper.Map(t);
        }
        // Named Type = typeof(T)
        foreach (var na in attr.NamedArguments)
        {
            if (na.Key == "Type" && na.Value.Value is ITypeSymbol t) return mapper.Map(t);
        }
        return null;
    }

    private static string StripAttrSuffix(string name) =>
        name.EndsWith("Attribute", StringComparison.Ordinal)
            ? name.Substring(0, name.Length - 9)
            : name;

    // Convention-based default status for a (verb, has-payload) pair. Used
    // when an action declares no [ProducesResponseType] — better than
    // always emitting "200" for POST/DELETE/PUT/PATCH.
    public static int InferDefaultStatus(string verb, bool hasSchema) => (verb, hasSchema) switch
    {
        ("POST", _) => 201,
        ("DELETE", false) => 204,
        ("PUT", false) => 204,
        ("PATCH", false) => 204,
        _ => 200,
    };

    public static string DescribeStatusPublic(int status) => DescribeStatus(status);

    private static string DescribeStatus(int status) => status switch
    {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No content",
        301 => "Moved permanently",
        302 => "Found",
        304 => "Not modified",
        400 => "Bad request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not found",
        409 => "Conflict",
        410 => "Gone",
        422 => "Unprocessable entity",
        429 => "Too many requests",
        500 => "Internal server error",
        502 => "Bad gateway",
        503 => "Service unavailable",
        _ => $"Status {status}",
    };
}
