using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Minimal API handlers returning IResult via Results.Ok(dto)/NotFound()/etc. get
// their responses recovered from the handler body (the return type is bare
// IResult and carries no schema).
public class MinimalApiResultTests
{
    [Fact]
    public void InlineLambda_ResultsOk_RecoversSchema()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapGet("/items/{id}", (int id) =>
                id > 0 ? Results.Ok(new Item()) : Results.NotFound());
            app.Run();

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/items/{id}");
        Assert.Equal(2, route.Responses!.Count);
        var ok = route.Responses.Single(r => r.Status == 200);
        Assert.Equal("Item", ok.Schema!.RefName);
        Assert.Null(route.Responses.Single(r => r.Status == 404).Schema);
    }

    [Fact]
    public void BlockLambda_ResultsCreated_MapsTo201WithSchema()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapPost("/items", (Item item) =>
            {
                return Results.Created("/items/1", item);
            });
            app.Run();

            public class Item { public int Id { get; set; } }
            """);

        var route = result.Route("POST", "/items");
        var created = Assert.Single(route.Responses!);
        Assert.Equal(201, created.Status);
        Assert.Equal("Item", created.Schema!.RefName);
    }

    [Fact]
    public void MethodGroupHandler_ResultsOk_Inspected()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapGet("/ping", Handler);
            app.Run();

            static IResult Handler() => Results.Ok(new Pong());

            public class Pong { public string Msg { get; set; } = ""; }
            """);

        var route = result.Route("GET", "/ping");
        var ok = Assert.Single(route.Responses!);
        Assert.Equal(200, ok.Status);
        Assert.Equal("Pong", ok.Schema!.RefName);
    }
}
