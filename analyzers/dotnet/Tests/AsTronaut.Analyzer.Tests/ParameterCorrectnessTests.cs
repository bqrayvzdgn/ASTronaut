using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Correctness of implicit parameter binding on controller actions:
//  - a constructor-injected EF Core DbContext is a service, never a request body
//    (E11b): the HasNoBindableSurface heuristic alone misreads it because a
//    DbContext exposes public settable DbSet<T> properties;
//  - an explicit [Required] on an otherwise-nullable action parameter makes it
//    required (L1b), mirroring how [Required] already works on DTO properties.
public class ParameterCorrectnessTests
{
    [Fact]
    public void ConcreteDbContextParam_IsTreatedAsService_NotBody()
    {
        // AppDbContext derives from EF Core's DbContext and — like every real
        // context — exposes a public settable DbSet<T> property, so it is NOT
        // "no bindable surface". It must still be recognized as a service.
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            using Microsoft.EntityFrameworkCore;

            namespace Microsoft.EntityFrameworkCore
            {
                public class DbContext { }
                public class DbSet<T> { }
            }

            namespace Demo
            {
                public class AppDbContext : DbContext
                {
                    public DbSet<Todo> Todos { get; set; } = new DbSet<Todo>();
                }

                public class Todo { public int Id { get; set; } }

                [ApiController]
                [Route("todos")]
                public class TodosController : ControllerBase
                {
                    [HttpGet]
                    public IActionResult List(AppDbContext db) => Ok();
                }
            }
            """);

        var route = result.Route("GET", "/todos");
        Assert.Null(route.RequestBody);  // the DbContext must not leak into the body
        Assert.Null(route.QueryParams);  // nor be flattened into query params
    }

    [Fact]
    public void BareStringParam_BindsToQuery_NotDroppedAsService()
    {
        // string is a class with no public settable property, so the service
        // heuristic used to misclassify it as an opaque service and drop it.
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;

            namespace Demo
            {
                [ApiController]
                [Route("search")]
                public class SearchController : ControllerBase
                {
                    [HttpGet]
                    public IActionResult Search(string term) => Ok();
                }
            }
            """);

        var route = result.Route("GET", "/search");
        var term = Assert.Single(route.QueryParams!);
        Assert.Equal("term", term.Name);
        Assert.Equal("string", term.Schema.PrimitiveType);
        Assert.Null(route.RequestBody);
    }

    [Fact]
    public void RequiredAttributeOnNullableParam_MarksParamRequired()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            using System.ComponentModel.DataAnnotations;

            namespace Demo
            {
                [ApiController]
                [Route("search")]
                public class SearchController : ControllerBase
                {
                    [HttpGet]
                    public IActionResult Search([Required] string? q) => Ok();
                }
            }
            """);

        var route = result.Route("GET", "/search");
        var q = Assert.Single(route.QueryParams!);
        Assert.Equal("q", q.Name);
        Assert.True(q.Required);  // [Required] overrides the nullable annotation
    }
}
