using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Actions returning IActionResult/ActionResult get their responses recovered from
// the body's return statements (Ok(dto), NotFound(), StatusCode(n, x), ...).
public class ControllerResultTests
{
    [Fact]
    public void IActionResult_RecoversStatusesAndSchemaFromReturns()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet("{id}")]
                public IActionResult Get(int id)
                {
                    if (id < 0) return NotFound();
                    return Ok(new Item());
                }
            }

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/items/{id}");
        Assert.Equal(2, route.Responses!.Count);

        var ok = route.Responses.Single(r => r.Status == 200);
        Assert.Equal("Item", ok.Schema!.RefName);

        var notFound = route.Responses.Single(r => r.Status == 404);
        Assert.Null(notFound.Schema);
    }

    [Fact]
    public void AsyncTaskIActionResult_UnwrapsAwaitedOkValue()
    {
        var result = TestCompilation.Walk("""
            using System.Collections.Generic;
            using System.Threading.Tasks;
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public async Task<IActionResult> List()
                {
                    await Task.Delay(1);
                    return Ok(new List<Item>());
                }
            }

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/items");
        var ok = Assert.Single(route.Responses!);
        Assert.Equal(200, ok.Status);
        Assert.Equal("ARRAY", ok.Schema!.Kind);
        Assert.Equal("Item", ok.Schema.Items!.RefName);
    }

    [Fact]
    public void StatusCodeHelper_UsesLiteralStatus()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("x")]
            public class XController : ControllerBase
            {
                [HttpPost]
                public IActionResult Post()
                {
                    return StatusCode(422, new Problem());
                }
            }

            public class Problem { public string Detail { get; set; } = ""; }
            """);

        var route = result.Route("POST", "/x");
        var r = Assert.Single(route.Responses!);
        Assert.Equal(422, r.Status);
        Assert.Equal("Problem", r.Schema!.RefName);
    }

    [Fact]
    public void AnonymousOkValue_IsInlineObject()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("x")]
            public class XController : ControllerBase
            {
                [HttpGet]
                public IActionResult Get() => Ok(new { count = 1, label = "hi" });
            }
            """);

        var route = result.Route("GET", "/x");
        var ok = Assert.Single(route.Responses!);
        Assert.Equal(200, ok.Status);
        Assert.Equal("OBJECT", ok.Schema!.Kind);
        Assert.Contains("count", ok.Schema.Properties!.Keys);
        Assert.Contains("label", ok.Schema.Properties.Keys);
    }
}
