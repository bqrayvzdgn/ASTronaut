using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Regression coverage for the controller path: route discovery, route-template
// combination, parameter binding, and return-type → response inference.
public class ControllerWalkerTests
{
    private const string UsersController = """
        using System.Collections.Generic;
        using Microsoft.AspNetCore.Mvc;

        namespace Demo;

        [ApiController]
        [Route("api/users")]
        public class UsersController : ControllerBase
        {
            [HttpGet]
            public ActionResult<List<User>> List() => new List<User>();

            [HttpGet("{id}")]
            public ActionResult<User> Get(int id) => new User();

            [HttpPost]
            public ActionResult<User> Create([FromBody] CreateUserDto dto) => new User();

            [HttpDelete("{id}")]
            public IActionResult Delete(int id) => NoContent();
        }

        public sealed class User
        {
            public int Id { get; set; }
            public required string Email { get; set; }
            public string? Name { get; set; }
        }

        public sealed class CreateUserDto
        {
            public required string Email { get; set; }
            public int Age { get; set; }
        }
        """;

    [Fact]
    public void DiscoversAllActions_WithCombinedRoutes()
    {
        var result = TestCompilation.Walk(UsersController);

        Assert.Equal(4, result.Routes.Count);
        Assert.Contains(result.Routes, r => r.Method == "GET" && r.Path == "/api/users");
        Assert.Contains(result.Routes, r => r.Method == "GET" && r.Path == "/api/users/{id}");
        Assert.Contains(result.Routes, r => r.Method == "POST" && r.Path == "/api/users");
        Assert.Contains(result.Routes, r => r.Method == "DELETE" && r.Path == "/api/users/{id}");
    }

    [Fact]
    public void BindsPathParam_FromRouteToken()
    {
        var result = TestCompilation.Walk(UsersController);
        var get = result.Route("GET", "/api/users/{id}");

        Assert.NotNull(get.PathParams);
        var id = Assert.Single(get.PathParams!);
        Assert.Equal("id", id.Name);
        Assert.Equal("integer", id.Schema.PrimitiveType);
        Assert.Null(get.QueryParams);
        Assert.Null(get.RequestBody);
    }

    [Fact]
    public void BindsComplexType_ToRequestBody_AsReference()
    {
        var result = TestCompilation.Walk(UsersController);
        var post = result.Route("POST", "/api/users");

        Assert.NotNull(post.RequestBody);
        Assert.Equal("application/json", post.RequestBody!.ContentType);
        Assert.Equal("REFERENCE", post.RequestBody.Schema.Kind);
        Assert.Equal("CreateUserDto", post.RequestBody.Schema.RefName);
    }

    [Fact]
    public void InfersResponse_FromReturnType_HoistingDto()
    {
        var result = TestCompilation.Walk(UsersController);
        var get = result.Route("GET", "/api/users/{id}");

        var response = Assert.Single(get.Responses!);
        Assert.Equal(200, response.Status);
        Assert.Equal("REFERENCE", response.Schema!.Kind);
        Assert.Equal("User", response.Schema.RefName);
        Assert.True(result.SharedSchemas.ContainsKey("User"));
    }

    [Fact]
    public void ProducesNoDiagnostics_ForWellFormedController()
    {
        var result = TestCompilation.Walk(UsersController);
        Assert.Empty(result.Errors);
    }

    // B17 — [AcceptVerbs("GET","POST")] must emit one route per listed verb.
    private const string AcceptVerbsController = """
        using Microsoft.AspNetCore.Mvc;

        namespace Demo;

        [ApiController]
        [Route("api/ping")]
        public class PingController : ControllerBase
        {
            [AcceptVerbs("GET", "POST")]
            public IActionResult Ping() => Ok();

            [AcceptVerbs("Put")]
            public IActionResult Replace() => Ok();
        }
        """;

    [Fact]
    public void AcceptVerbs_EmitsRoutePerVerb()
    {
        var result = TestCompilation.Walk(AcceptVerbsController);

        Assert.Contains(result.Routes, r => r.Method == "GET" && r.Path == "/api/ping");
        Assert.Contains(result.Routes, r => r.Method == "POST" && r.Path == "/api/ping");
        // Single-string form, case-insensitive normalization to POST-style verbs.
        Assert.Contains(result.Routes, r => r.Method == "PUT" && r.Path == "/api/ping");
        Assert.Equal(3, result.Routes.Count);
    }

    // B13 — a non-abstract open generic controller (unbound type parameter) must
    // be skipped instead of emitting routes with an unresolved T body.
    private const string OpenGenericController = """
        using Microsoft.AspNetCore.Mvc;

        namespace Demo;

        [ApiController]
        [Route("api/[controller]")]
        public class RepoController<T> : ControllerBase
        {
            [HttpPost]
            public IActionResult Create([FromBody] T item) => Ok();
        }
        """;

    [Fact]
    public void OpenGenericController_IsSkipped_WithW004()
    {
        var result = TestCompilation.Walk(OpenGenericController);

        Assert.Empty(result.Routes);
        var w004 = Assert.Single(result.Errors);
        Assert.Equal("W004", w004.Code);
        Assert.Equal("warning", w004.Severity);
    }

    // B13 — a concrete controller deriving from a closed generic base is not an
    // open generic and must still emit its routes with no W004.
    private const string ClosedGenericBaseController = """
        using Microsoft.AspNetCore.Mvc;

        namespace Demo;

        public abstract class BaseController<T> : ControllerBase
        {
        }

        [ApiController]
        [Route("api/orders")]
        public class OrdersController : BaseController<Order>
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }

        public sealed class Order { public int Id { get; set; } }
        """;

    [Fact]
    public void ConcreteControllerOverClosedGenericBase_EmitsRoutes_NoW004()
    {
        var result = TestCompilation.Walk(ClosedGenericBaseController);

        Assert.Contains(result.Routes, r => r.Method == "GET" && r.Path == "/api/orders");
        Assert.DoesNotContain(result.Errors, e => e.Code == "W004");
    }
}
