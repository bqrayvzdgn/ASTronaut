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
}
