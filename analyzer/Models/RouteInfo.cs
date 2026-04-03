using System.Text.Json.Serialization;

namespace AutoDocAnalyzer.Models;

public class ParseResult
{
    [JsonPropertyName("routes")]
    public List<RouteInfo> Routes { get; set; } = new();

    [JsonPropertyName("errors")]
    public List<ParseError> Errors { get; set; } = new();
}

public class RouteInfo
{
    [JsonPropertyName("path")]
    public string Path { get; set; } = string.Empty;

    [JsonPropertyName("method")]
    public string Method { get; set; } = "GET";

    [JsonPropertyName("controller")]
    public string? Controller { get; set; }

    [JsonPropertyName("routePrefix")]
    public string? RoutePrefix { get; set; }

    [JsonPropertyName("params")]
    public List<ParamInfo> Params { get; set; } = new();

    [JsonPropertyName("requestBody")]
    public RequestBodyInfo? RequestBody { get; set; }

    [JsonPropertyName("responses")]
    public List<ResponseInfo> Responses { get; set; } = new();

    [JsonPropertyName("auth")]
    public string? Auth { get; set; }

    [JsonPropertyName("middleware")]
    public List<string> Middleware { get; set; } = new();

    [JsonPropertyName("description")]
    public string? Description { get; set; }

    [JsonPropertyName("source")]
    public string Source { get; set; } = string.Empty;
}

public class ParamInfo
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("in")]
    public string In { get; set; } = "query";

    [JsonPropertyName("type")]
    public string Type { get; set; } = "string";

    [JsonPropertyName("required")]
    public bool Required { get; set; }
}

public class RequestBodyInfo
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("contentType")]
    public string? ContentType { get; set; }

    [JsonPropertyName("properties")]
    public List<PropertyInfo> Properties { get; set; } = new();
}

public class ResponseInfo
{
    [JsonPropertyName("status")]
    public int Status { get; set; } = 200;

    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("properties")]
    public List<PropertyInfo> Properties { get; set; } = new();
}

public class PropertyInfo
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; set; } = "string";

    [JsonPropertyName("required")]
    public bool Required { get; set; }
}

public class ParseError
{
    [JsonPropertyName("file")]
    public string File { get; set; } = string.Empty;

    [JsonPropertyName("reason")]
    public string Reason { get; set; } = string.Empty;
}
