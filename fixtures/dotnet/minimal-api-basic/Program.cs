using Microsoft.AspNetCore.Mvc;

var app = WebApplication.Create();

app.MapGet("/ping", () => "pong");

app.MapGet("/items/{id:int:min(1)}", (int id) => new Item(id, "name"));

app.MapPost("/items", ([FromBody] CreateItem dto) => new Item(1, dto.Name));

app.MapPut("/items/{id:int}", (int id, [FromBody] CreateItem dto)
    => new Item(id, dto.Name));

app.MapDelete("/items/{id:int}", (int id) => Results.NoContent());

app.MapPatch("/items/{id:int}/touch", (int id) => Results.Ok());

app.Run();

record Item(int Id, string Name);
record CreateItem(string Name, int Quantity);
