using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// [FromHeader]/[FromQuery]/[FromRoute] carry an optional Name="..." argument that
// renames the bound parameter on the wire. The spec parameter name must come from
// that override (e.g. "X-Trace-Id"), not the C# identifier.
public class BindingNameOverrideTests
{
    [Fact]
    public void FromHeaderName_OverridesParamName()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List([FromHeader(Name = "X-Trace-Id")] string traceId) => Ok();
            }
            """);

        var route = result.Route("GET", "/items");
        var header = Assert.Single(route.HeaderParams!);
        Assert.Equal("X-Trace-Id", header.Name);
        // The C# identifier must not leak through.
        Assert.NotEqual("traceId", header.Name);
    }

    [Fact]
    public void FromQueryName_OverridesParamName()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List([FromQuery(Name = "page_size")] int pageSize) => Ok();
            }
            """);

        var route = result.Route("GET", "/items");
        var q = Assert.Single(route.QueryParams!);
        Assert.Equal("page_size", q.Name);
    }

    [Fact]
    public void FromRouteName_OverridesParamName()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet("{id}")]
                public IActionResult Get([FromRoute(Name = "id")] int itemId) => Ok();
            }
            """);

        var route = result.Route("GET", "/items/{id}");
        // The path parameter is named after the route token via the Name override,
        // and there is exactly one (no stray "itemId").
        var p = Assert.Single(route.PathParams!);
        Assert.Equal("id", p.Name);
        Assert.Equal("integer", p.Schema.PrimitiveType);
    }

    [Fact]
    public void NoNameArgument_FallsBackToCSharpName()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List([FromHeader] string authorization) => Ok();
            }
            """);

        var route = result.Route("GET", "/items");
        var header = Assert.Single(route.HeaderParams!);
        Assert.Equal("authorization", header.Name);
    }
}
