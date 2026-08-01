using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// [Consumes]/[Produces] declare multiple media types sharing one schema, which
// the IR now carries via BodyInfo.ContentTypes / ResponseInfo.ContentTypes.
public class ContentNegotiationTests
{
    [Fact]
    public void Consumes_PopulatesBodyContentTypes()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpPost]
                [Consumes("application/json", "application/xml")]
                public Item Create([FromBody] Item i) => i;
            }

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("POST", "/items");
        Assert.NotNull(route.RequestBody);
        Assert.Equal("application/json", route.RequestBody!.ContentType);
        Assert.Equal(new[] { "application/json", "application/xml" }, route.RequestBody.ContentTypes);
    }

    [Fact]
    public void Produces_PopulatesResponseContentTypes()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                [Produces("application/json", "application/xml")]
                public Item Get() => new Item();
            }

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/items");
        var response = Assert.Single(route.Responses!);
        Assert.NotNull(response.Schema);
        Assert.Equal(new[] { "application/json", "application/xml" }, response.ContentTypes);
    }

    [Fact]
    public void ControllerLevelConsumes_AppliesToActions()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            [Consumes("application/xml")]
            public class ItemsController : ControllerBase
            {
                [HttpPost]
                public Item Create([FromBody] Item i) => i;
            }

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("POST", "/items");
        Assert.Equal(new[] { "application/xml" }, route.RequestBody!.ContentTypes);
    }
}
