using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var api = app.MapGroup("/api");

// .RequireAuthorization() in the chain → bearer security on this endpoint.
api.MapGet("/profile", () => new Profile("alice", "alice@example.com"))
    .WithTags("account")
    .RequireAuthorization();

// AllowAnonymous wins.
api.MapGet("/ping", () => "pong")
    .WithTags("infra")
    .AllowAnonymous();

// Method-reference handler — XML doc + [Authorize] + [ProducesResponseType]
// are read from the method itself.
api.MapPost("/items", ItemHandlers.Create)
    .WithTags("items");

app.Run();

record Profile(string Username, string Email);
record Item(int Id, string Name);
record CreateItem(string Name);

static class ItemHandlers
{
    /// <summary>Create a new item.</summary>
    /// <param name="dto">The item to create.</param>
    [Authorize]
    [ProducesResponseType(typeof(Item), 201)]
    [ProducesResponseType(400)]
    public static Item Create([FromBody] CreateItem dto)
        => new Item(1, dto.Name);
}
