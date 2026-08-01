using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Minimal API TypedResults: Results<...> unions and single typed results expand
// into one response per member, with the generic argument as the body schema.
public class TypedResultsTests
{
    [Fact]
    public void ResultsUnion_ExpandsToMultipleResponses()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;
            using Microsoft.AspNetCore.Http.HttpResults;

            var app = WebApplication.Create();
            app.MapGet("/todos/{id}", (int id) => Handler(id));
            app.Run();

            static Results<Ok<Todo>, NotFound> Handler(int id) =>
                id > 0 ? TypedResults.Ok(new Todo()) : TypedResults.NotFound();

            public class Todo { public int Id { get; set; } }
            """);

        var route = result.Route("GET", "/todos/{id}");
        Assert.NotNull(route.Responses);
        Assert.Equal(2, route.Responses!.Count);

        var ok = route.Responses.Single(r => r.Status == 200);
        Assert.Equal("REFERENCE", ok.Schema!.Kind);
        Assert.Equal("Todo", ok.Schema.RefName);

        var notFound = route.Responses.Single(r => r.Status == 404);
        Assert.Null(notFound.Schema);
    }

    [Fact]
    public void SingleTypedResult_MapsToOneResponseWithSchema()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;
            using Microsoft.AspNetCore.Http.HttpResults;

            var app = WebApplication.Create();
            app.MapPost("/todos", () => Create());
            app.Run();

            static Created<Todo> Create() => TypedResults.Created("/todos/1", new Todo());

            public class Todo { public int Id { get; set; } }
            """);

        var route = result.Route("POST", "/todos");
        var response = Assert.Single(route.Responses!);
        Assert.Equal(201, response.Status);
        Assert.Equal("Todo", response.Schema!.RefName);
    }

    [Fact]
    public void InlineLambdaReturningTypedResult_IsRecognized()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapGet("/ping", () => TypedResults.Ok(new Pong()));
            app.Run();

            public class Pong { public string Msg { get; set; } = ""; }
            """);

        var route = result.Route("GET", "/ping");
        var response = Assert.Single(route.Responses!);
        Assert.Equal(200, response.Status);
        Assert.Equal("Pong", response.Schema!.RefName);
    }
}
