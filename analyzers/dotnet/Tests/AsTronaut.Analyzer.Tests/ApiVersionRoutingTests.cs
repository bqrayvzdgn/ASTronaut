using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// URL-segment API versioning: [ApiVersion("x")] on the controller instantiates
// the {version:apiVersion} route token into a concrete path segment. Multiple
// [ApiVersion] attributes fan out to one route per declared version.
//
// The Asp.Versioning.ApiVersionAttribute lives in a package that is not on the
// test framework reference set, so a minimal stub is declared inline and the
// analyzer matches it by short attribute name (AttributeReader.HasAttribute).
public class ApiVersionRoutingTests
{
    private const string AspVersioningStub = """
        namespace Asp.Versioning
        {
            public class ApiVersionAttribute : System.Attribute
            {
                public ApiVersionAttribute(string v) { }
            }
        }
        """;

    [Fact]
    public void SingleApiVersion_InstantiatesVersionToken()
    {
        var result = TestCompilation.Walk($$"""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            {{AspVersioningStub}}

            [ApiController]
            [Asp.Versioning.ApiVersion("1.0")]
            [Route("api/v{version:apiVersion}/[controller]")]
            public class ProductsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List() => Ok();
            }
            """);

        var route = Assert.Single(result.Routes);
        Assert.Equal("GET", route.Method);
        Assert.Equal("/api/v1.0/Products", route.Path);
        // The version segment is now a literal, not a bound path parameter.
        Assert.Null(route.PathParams);
    }

    [Fact]
    public void MultipleApiVersions_FanOutToOneRoutePerVersion()
    {
        var result = TestCompilation.Walk($$"""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            {{AspVersioningStub}}

            [ApiController]
            [Asp.Versioning.ApiVersion("1.0")]
            [Asp.Versioning.ApiVersion("2.0")]
            [Route("api/v{version:apiVersion}/[controller]")]
            public class OrdersController : ControllerBase
            {
                [HttpGet("{id}")]
                public IActionResult Get(int id) => Ok();
            }
            """);

        Assert.Equal(2, result.Routes.Count);
        Assert.Contains(result.Routes, r => r.Path == "/api/v1.0/Orders/{id}");
        Assert.Contains(result.Routes, r => r.Path == "/api/v2.0/Orders/{id}");

        // The real {id} path parameter still binds on each version.
        foreach (var route in result.Routes)
        {
            var id = Assert.Single(route.PathParams!);
            Assert.Equal("id", id.Name);
            Assert.Equal("integer", id.Schema.PrimitiveType);
        }
    }

    [Fact]
    public void ApiVersionToken_WithoutAttribute_IsUnchanged()
    {
        // No [ApiVersion] present: the {version:apiVersion} token must fall
        // through unchanged (parsed as a plain path param) — no regression.
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("api/v{version:apiVersion}/[controller]")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List() => Ok();
            }
            """);

        var route = Assert.Single(result.Routes);
        Assert.Equal("/api/v{version}/Items", route.Path);
        var version = Assert.Single(route.PathParams!);
        Assert.Equal("version", version.Name);
    }

    [Fact]
    public void ApiVersionAttribute_WithoutToken_LeavesRouteUnchanged()
    {
        // [ApiVersion] declared but the template has no apiVersion token: the
        // path must be emitted exactly once, unchanged.
        var result = TestCompilation.Walk($$"""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            {{AspVersioningStub}}

            [ApiController]
            [Asp.Versioning.ApiVersion("1.0")]
            [Route("api/[controller]")]
            public class WidgetsController : ControllerBase
            {
                [HttpGet]
                public IActionResult List() => Ok();
            }
            """);

        var route = Assert.Single(result.Routes);
        Assert.Equal("/api/Widgets", route.Path);
    }
}
