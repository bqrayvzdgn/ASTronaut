using Microsoft.AspNetCore.Mvc;

namespace Alpha.Controllers;

// Two .csproj files under one directory and no .sln: both the CLI (detect.ts,
// localeCompare) and the analyzer (ProjectLoader, Ordinal) must pick this
// project — "Alpha" sorts first under both comparers (A14) — and report W007.
[ApiController]
[Route("api/alpha")]
public class AlphaController : ControllerBase
{
    [HttpGet]
    public ActionResult<AlphaItem> Get()
    {
        return new AlphaItem { Id = 1 };
    }
}

public sealed class AlphaItem
{
    public int Id { get; set; }
}
