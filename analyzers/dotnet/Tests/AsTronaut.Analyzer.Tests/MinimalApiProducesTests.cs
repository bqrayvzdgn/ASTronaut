using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// .Produces<T>()/.ProducesProblem()/.Accepts<T>() fluent declarations feed the
// response/request schemas.
public class MinimalApiProducesTests
{
    [Fact]
    public void ProducesGeneric_DeclaresResponseSchema()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapGet("/items", () => Results.Ok())
               .Produces<Item>(200)
               .ProducesProblem(404);
            app.Run();

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/items");
        var ok = route.Responses!.Single(r => r.Status == 200);
        Assert.Equal("Item", ok.Schema!.RefName);
        Assert.Contains(route.Responses, r => r.Status == 404);
    }

    [Fact]
    public void AcceptsGeneric_DeclaresRequestBody()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapPost("/items", () => Results.Ok())
               .Accepts<Item>("application/json");
            app.Run();

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("POST", "/items");
        Assert.NotNull(route.RequestBody);
        Assert.Equal("Item", route.RequestBody!.Schema.RefName);
        Assert.Equal("application/json", route.RequestBody.ContentType);
    }
}
