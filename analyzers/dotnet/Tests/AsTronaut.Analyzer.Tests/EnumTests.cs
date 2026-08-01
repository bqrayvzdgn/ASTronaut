using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Enums follow System.Text.Json semantics: numeric by default, string only when
// a JsonStringEnumConverter applies (globally or per-enum via [JsonConverter]).
public class EnumTests
{
    private static string Controller(string extra) => $$"""
        using Microsoft.AspNetCore.Mvc;
        using System.Text.Json.Serialization;
        namespace Demo;

        [ApiController]
        [Route("x")]
        public class XController : ControllerBase
        {
            [HttpPost]
            public Holder Post([FromBody] Holder h) => h;
        }

        public class Holder { public Status Status { get; set; } }

        {{extra}}

        public enum Status { Active = 1, Inactive = 2, Archived = 5 }
        """;

    [Fact]
    public void Default_IsIntegerWithNumericValues()
    {
        var result = TestCompilation.Walk(Controller(""));
        var status = result.SharedSchemas["Holder"].Properties!["status"];

        Assert.Equal("integer", status.PrimitiveType);
        Assert.Equal("int32", status.Format);
        Assert.Equal(new[] { "1", "2", "5" }, status.Constraints!.EnumValues);
    }

    [Fact]
    public void PerEnumStringConverter_ForcesStringNames()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            using System.Text.Json.Serialization;
            namespace Demo;

            [ApiController]
            [Route("x")]
            public class XController : ControllerBase
            {
                [HttpPost]
                public Holder Post([FromBody] Holder h) => h;
            }

            public class Holder { public Status Status { get; set; } }

            [JsonConverter(typeof(JsonStringEnumConverter))]
            public enum Status { Active, Inactive }
            """);

        var status = result.SharedSchemas["Holder"].Properties!["status"];
        Assert.Equal("string", status.PrimitiveType);
        Assert.Equal(new[] { "\"Active\"", "\"Inactive\"" }, status.Constraints!.EnumValues);
    }

    [Fact]
    public void GlobalStringConverter_MakesEnumsStringByDefault()
    {
        // A single new JsonStringEnumConverter() anywhere in the compilation
        // (typically registered in Program.cs) flips the default to string.
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            using System.Text.Json.Serialization;
            namespace Demo;

            [ApiController]
            [Route("x")]
            public class XController : ControllerBase
            {
                [HttpPost]
                public Holder Post([FromBody] Holder h) => h;
            }

            public class Holder { public Status Status { get; set; } }
            public enum Status { Active, Inactive }

            public static class Config
            {
                public static readonly JsonStringEnumConverter Converter = new JsonStringEnumConverter();
            }
            """);

        var status = result.SharedSchemas["Holder"].Properties!["status"];
        Assert.Equal("string", status.PrimitiveType);
    }
}
