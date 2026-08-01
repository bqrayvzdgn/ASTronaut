using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Workstream C: DTO property names in the emitted schema must match the real
// serialized wire format — honoring [JsonPropertyName], [JsonIgnore], and the
// Newtonsoft [JsonProperty] name, with a camelCase default otherwise.
public class SchemaNamingTests
{
    private static string Controller(string dtoBody) => $$"""
        using Microsoft.AspNetCore.Mvc;
        using System.Text.Json.Serialization;

        namespace Demo;

        [ApiController]
        [Route("things")]
        public class ThingsController : ControllerBase
        {
            [HttpPost]
            public Thing Create([FromBody] Thing t) => t;
        }

        public sealed class Thing
        {
        {{dtoBody}}
        }
        """;

    [Fact]
    public void DefaultsToCamelCase()
    {
        var result = TestCompilation.Walk(Controller("""
            public int UserId { get; set; }
            public string DisplayName { get; set; } = "";
        """));

        var keys = result.SchemaPropertyKeys("Thing");
        Assert.Contains("userId", keys);
        Assert.Contains("displayName", keys);
    }

    [Fact]
    public void HonorsJsonPropertyName()
    {
        var result = TestCompilation.Walk(Controller("""
            [JsonPropertyName("user_id")]
            public int UserId { get; set; }
        """));

        var keys = result.SchemaPropertyKeys("Thing");
        Assert.Contains("user_id", keys);
        Assert.DoesNotContain("userId", keys);
    }

    [Fact]
    public void SkipsUnconditionalJsonIgnore()
    {
        var result = TestCompilation.Walk(Controller("""
            public int Id { get; set; }
            [JsonIgnore]
            public string Secret { get; set; } = "";
        """));

        var keys = result.SchemaPropertyKeys("Thing");
        Assert.Contains("id", keys);
        Assert.DoesNotContain("secret", keys);
    }

    [Fact]
    public void KeepsConditionalJsonIgnore()
    {
        var result = TestCompilation.Walk(Controller("""
            [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
            public string? Note { get; set; }
        """));

        var keys = result.SchemaPropertyKeys("Thing");
        Assert.Contains("note", keys);
    }

    [Fact]
    public void JsonPropertyNameAlsoDrivesRequiredList()
    {
        var result = TestCompilation.Walk(Controller("""
            [JsonPropertyName("email_address")]
            public required string Email { get; set; }
        """));

        Assert.True(result.SharedSchemas.TryGetValue("Thing", out var schema));
        Assert.NotNull(schema!.RequiredProperties);
        Assert.Contains("email_address", schema.RequiredProperties!);
        Assert.DoesNotContain("email", schema.RequiredProperties!);
    }
}
