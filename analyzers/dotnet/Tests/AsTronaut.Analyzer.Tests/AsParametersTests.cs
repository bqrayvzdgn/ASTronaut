using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// [AsParameters] flattens a container type's public properties into individual
// parameters. Each property binds by ASP.NET convention: a property whose name
// matches a route token becomes a path parameter, everything else a query
// parameter. The container itself must never bind as a request body.
public class AsParametersTests
{
    [Fact]
    public void AsParameters_FlattensPropertiesToQuery_NotBody()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List([AsParameters] ListQuery q) => Ok();
            }

            public class ListQuery
            {
                public int Page { get; set; }
                public string? Search { get; set; }
                public required string Sort { get; set; }
            }
            """);

        var route = result.Route("GET", "/items");

        // The container must not become a JSON body.
        Assert.Null(route.RequestBody);

        var names = route.QueryParams!.Select(p => p.Name).ToList();
        Assert.Contains("page", names);
        Assert.Contains("search", names);
        Assert.Contains("sort", names);
        Assert.DoesNotContain("q", names);

        Assert.Equal("integer", route.QueryParams!.Single(p => p.Name == "page").Schema.PrimitiveType);
        Assert.True(route.QueryParams!.Single(p => p.Name == "sort").Required);
    }

    [Fact]
    public void AsParameters_RouteTokenProperty_BindsToPath()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet("{id}")]
                public IActionResult Get([AsParameters] ItemRequest req) => Ok();
            }

            public class ItemRequest
            {
                public int Id { get; set; }
                public bool IncludeArchived { get; set; }
            }
            """);

        var route = result.Route("GET", "/items/{id}");

        Assert.Null(route.RequestBody);

        // The property matching the {id} route token binds to the path.
        var id = Assert.Single(route.PathParams!);
        Assert.Equal("id", id.Name);
        Assert.Equal("integer", id.Schema.PrimitiveType);

        // The remaining property binds to the query.
        var q = Assert.Single(route.QueryParams!);
        Assert.Equal("includeArchived", q.Name);
    }
}
