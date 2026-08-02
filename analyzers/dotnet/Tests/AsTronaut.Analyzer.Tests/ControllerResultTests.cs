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

    // G36: a schema-less [ProducesResponseType(200)] declaration is completed
    // with the schema recovered from the body's `return Ok(dto)`, while other
    // declared statuses (404) are preserved.
    [Fact]
    public void ProducesResponseType_StatuslessDeclaration_FilledFromOkBody()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet("{id}")]
                [ProducesResponseType(200)]
                [ProducesResponseType(404)]
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
        Assert.Equal("application/json", ok.ContentType);

        // The declared 404 stays schema-less (NotFound() carries no body).
        var notFound = route.Responses.Single(r => r.Status == 404);
        Assert.Null(notFound.Schema);
    }

    // G36 regression guard: an explicit typeof schema on [ProducesResponseType]
    // is authoritative and must NOT be overwritten by the body's return value.
    [Fact]
    public void ProducesResponseType_ExplicitSchema_NotOverriddenByBody()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet("{id}")]
                [ProducesResponseType(typeof(Item), 200)]
                public IActionResult Get(int id) => Ok(new Other());
            }

            public class Item { public int Id { get; set; } }
            public class Other { public string Name { get; set; } = ""; }
            """);

        var route = result.Route("GET", "/items/{id}");
        var ok = Assert.Single(route.Responses!);
        Assert.Equal(200, ok.Status);
        Assert.Equal("Item", ok.Schema!.RefName);
    }

    // G36: the schema can also be completed from the return type when the action
    // returns a payload directly (no ControllerBase helper in the body).
    [Fact]
    public void ProducesResponseType_StatuslessDeclaration_FilledFromReturnType()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                [ProducesResponseType(200)]
                public ActionResult<Item> Get() => new Item();
            }

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/items");
        var ok = Assert.Single(route.Responses!);
        Assert.Equal(200, ok.Status);
        Assert.Equal("Item", ok.Schema!.RefName);
    }
}
