using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// [FromQuery] on a complex object flattens into one query parameter per property;
// free-form JSON containers map to an unconstrained object.
public class QueryBindingTests
{
    [Fact]
    public void FromQueryComplexObject_FlattensToPerPropertyParams()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List([FromQuery] Filter filter) => Ok();
            }

            public class Filter
            {
                public int Page { get; set; }
                public string? Search { get; set; }
                public required string Sort { get; set; }
            }
            """);

        var route = result.Route("GET", "/items");
        var names = route.QueryParams!.Select(q => q.Name).ToList();

        Assert.Contains("page", names);
        Assert.Contains("search", names);
        Assert.Contains("sort", names);
        // The container object itself is not a single query parameter.
        Assert.DoesNotContain("filter", names);

        var page = route.QueryParams!.Single(q => q.Name == "page");
        Assert.Equal("integer", page.Schema.PrimitiveType);
        Assert.True(route.QueryParams!.Single(q => q.Name == "sort").Required);
    }

    [Fact]
    public void FromQueryScalar_StaysASingleParam()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List([FromQuery] int page) => Ok();
            }
            """);

        var route = result.Route("GET", "/items");
        var q = Assert.Single(route.QueryParams!);
        Assert.Equal("page", q.Name);
    }

    [Fact]
    public void JsonElement_IsFreeFormObject()
    {
        var result = TestCompilation.Walk("""
            using System.Text.Json;
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("x")]
            public class XController : ControllerBase
            {
                [HttpPost]
                public IActionResult Post([FromBody] Payload p) => Ok();
            }

            public class Payload { public JsonElement Data { get; set; } }
            """);

        var data = result.SharedSchemas["Payload"].Properties!["data"];
        Assert.Equal("OBJECT", data.Kind);
        Assert.Null(data.Properties); // no leaked internal members
    }
}
