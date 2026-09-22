using Microsoft.AspNetCore.Mvc;

namespace DiagnosticsOpenGeneric.Controllers;

[ApiController]
[Route("api/items")]
public class ItemsController : ControllerBase
{
    [HttpGet]
    public ActionResult<List<Item>> List()
    {
        return new List<Item>();
    }
}

public sealed class Item
{
    public int Id { get; set; }
    public required string Name { get; set; }
}
