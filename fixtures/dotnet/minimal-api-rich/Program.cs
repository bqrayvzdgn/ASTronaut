using Microsoft.AspNetCore.Mvc;

var app = WebApplication.Create();

var api = app.MapGroup("/api/v1");

// Inline lambda + fluent chain.
api.MapGet("/health", () => new { ok = true })
    .WithName("Healthcheck")
    .WithTags("infra");

// Nested MapGroup.
var users = api.MapGroup("/users");

users.MapGet("/", () => new List<User>())
    .WithTags("users");

users.MapGet("/{id:long}", (long id) => new User(id, "name"))
    .WithName("GetUser")
    .WithTags("users");

users.MapPost("/", ([FromBody] CreateUser dto) => new User(1, dto.Name))
    .WithName("CreateUser")
    .WithTags("users");

// Method-reference handler.
users.MapDelete("/{id:long}", UserHandlers.Delete)
    .WithTags("users", "admin");

// Inline chained MapGroup.
api.MapGroup("/admin").MapGet("/stats", () => new Stats(0, 0))
    .WithTags("admin");

app.Run();

record User(long Id, string Name);
record CreateUser(string Name);
record Stats(long Users, long Items);

static class UserHandlers
{
    public static IResult Delete(long id) => Results.NoContent();
}
