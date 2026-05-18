using Microsoft.AspNetCore.Mvc;

namespace ControllersRouteParams.Controllers;

[ApiController]
[Route("api/v1/[controller]")]
public class ItemsController : ControllerBase
{
    // Numeric route constraint with min bound.
    [HttpGet("{id:int:min(1)}")]
    public ActionResult<Item> GetById(int id)
    {
        return new Item { Id = id, Name = "" };
    }

    // GUID route constraint.
    [HttpGet("by-uuid/{uuid:guid}")]
    public ActionResult<Item> GetByUuid(Guid uuid)
    {
        return new Item { Id = 0, Name = uuid.ToString() };
    }

    // String constraint: alpha + length range.
    [HttpGet("by-slug/{slug:alpha:length(3,40)}")]
    public ActionResult<Item> GetBySlug(string slug)
    {
        return new Item { Id = 0, Name = slug };
    }

    // Query parameters, no body.
    [HttpGet("search")]
    public ActionResult<List<Item>> Search(
        [FromQuery] string? q,
        [FromQuery] int page = 1,
        [FromQuery] int size = 20)
    {
        return new List<Item>();
    }

    // Header parameter.
    [HttpGet("traced")]
    public ActionResult<Item> Traced([FromHeader(Name = "X-Trace-Id")] string traceId)
    {
        return new Item { Id = 0, Name = traceId };
    }
}

public sealed class Item
{
    public int Id { get; set; }
    public required string Name { get; set; }
}
