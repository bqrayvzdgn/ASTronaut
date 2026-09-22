using Microsoft.AspNetCore.Mvc;

namespace Beta.Controllers;

// The project that must NOT be analyzed: it sorts after Alpha, so nothing from
// here may appear in the golden.
[ApiController]
[Route("api/beta")]
public class BetaController : ControllerBase
{
    [HttpGet]
    public ActionResult<BetaItem> Get()
    {
        return new BetaItem { Id = 1 };
    }
}

public sealed class BetaItem
{
    public int Id { get; set; }
}
