using System.Text.Json.Serialization;

namespace AsTronaut.Analyzer.Ir;

// IR DTOs — proto-aligned (camelCase JSON via JsonSerializerOptions). Fields use
// strings instead of C# enums for HttpMethod / SchemaKind / PrimitiveType / AuthType
// so that the JSON wire format exactly matches what the TS zod validator expects.

public sealed record ParseResult
{
    public List<RouteInfo> Routes { get; init; } = new();
    public List<ParseError> Errors { get; init; } = new();
    public ParserMetadata Metadata { get; init; } = new();

    [JsonPropertyName("sharedSchemas")]
    public Dictionary<string, Schema>? SharedSchemas { get; init; }
}

public sealed record RouteInfo
{
    // "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "TRACE"
    public string Method { get; init; } = "";
    public string Path { get; init; } = "";

    public List<ParamInfo>? PathParams { get; init; }
    public List<ParamInfo>? QueryParams { get; init; }
    public List<ParamInfo>? HeaderParams { get; init; }

    public BodyInfo? RequestBody { get; init; }
    public List<ResponseInfo>? Responses { get; init; }

    public AuthInfo? Auth { get; init; }

    public string? Summary { get; init; }
    public string? Description { get; init; }
    public string? OperationId { get; init; }
    public List<string>? Tags { get; init; }
    public bool? Deprecated { get; init; }

    public SourceLocation Source { get; init; } = new();
}

public sealed record ParamInfo
{
    public string Name { get; init; } = "";
    public Schema Schema { get; init; } = new();
    public bool Required { get; init; }
    public string? Description { get; init; }
    public string? Example { get; init; }
}

public sealed record BodyInfo
{
    public string ContentType { get; init; } = "application/json";
    public Schema Schema { get; init; } = new();
    public bool Required { get; init; }
    // All accepted content types (from [Consumes]); all share Schema.
    public List<string>? ContentTypes { get; init; }
}

public sealed record ResponseInfo
{
    public int Status { get; init; }
    public string Description { get; init; } = "";
    public Schema? Schema { get; init; }
    public string? ContentType { get; init; }
    public Dictionary<string, ParamInfo>? Headers { get; init; }
    // All produced content types (from [Produces]); all share Schema.
    public List<string>? ContentTypes { get; init; }
}

public sealed record Schema
{
    // "PRIMITIVE" | "OBJECT" | "ARRAY" | "REFERENCE" | "ONE_OF" | "ANY_OF" | "ALL_OF"
    public string Kind { get; init; } = "PRIMITIVE";

    public string? RefName { get; init; }

    // "string" | "integer" | "number" | "boolean" | "null"
    public string? PrimitiveType { get; init; }

    // OpenAPI format hint: "int32" | "int64" | "date-time" | "uuid" | "email" | ...
    public string? Format { get; init; }

    public Dictionary<string, Schema>? Properties { get; init; }
    public List<string>? RequiredProperties { get; init; }
    public Schema? Items { get; init; }
    public List<Schema>? Variants { get; init; }

    public Constraints? Constraints { get; init; }
    public bool? Nullable { get; init; }

    public string? Description { get; init; }
    public string? DefaultValue { get; init; }
    public string? Example { get; init; }
}

public sealed record Constraints
{
    public double? Minimum { get; set; }
    public double? Maximum { get; set; }
    public double? ExclusiveMinimum { get; set; }
    public double? ExclusiveMaximum { get; set; }
    public int? MinLength { get; set; }
    public int? MaxLength { get; set; }
    public int? MinItems { get; set; }
    public int? MaxItems { get; set; }
    public bool? UniqueItems { get; set; }
    public string? Pattern { get; set; }
    public List<string>? EnumValues { get; set; }
    public double? MultipleOf { get; set; }
}

public sealed record AuthInfo
{
    // "http" | "apiKey" | "mutualTLS" | "oauth2" | "openIdConnect"
    public string Type { get; init; } = "";
    public string? Scheme { get; init; }
    public string? Name { get; init; }
    // "header" | "query" | "cookie"
    public string? In { get; init; }
    public string? BearerFormat { get; init; }
    public string Id { get; init; } = "";
}

public sealed record ParseError
{
    public string File { get; init; } = "";
    public int Line { get; init; }
    public string Message { get; init; } = "";
    // "warning" | "error"
    public string Severity { get; init; } = "error";
    public string? Code { get; init; }
}

public sealed record ParserMetadata
{
    public string Framework { get; init; } = "aspnet";
    public string? FrameworkVersion { get; init; }
    public int FilesScanned { get; init; }
    public long DurationMs { get; init; }
    public string ParserVersion { get; init; } = "0.0.1";
}

public sealed record SourceLocation
{
    public string File { get; init; } = "";
    public int Line { get; init; }
    public int Column { get; init; }
}
