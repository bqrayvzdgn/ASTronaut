using Asp.Versioning;
using Microsoft.AspNetCore.Mvc;

namespace ControllersFeatures.Controllers;

// B14: URL-segment versioning fans [ApiVersion] out to one route per version.
// B32: [MapToApiVersion] pins an action to a subset — no route is invented for
// versions it does not declare.
[ApiController]
[ApiVersion("1.0")]
[ApiVersion("2.0")]
[Route("api/v{version:apiVersion}/[controller]")]
public class ReportsController : ControllerBase
{
    // Reachable as /api/v1.0/Reports and /api/v2.0/Reports.
    [HttpGet]
    public ActionResult<List<Report>> List()
    {
        return new List<Report>();
    }

    // Reachable only as /api/v2.0/Reports/summary.
    [HttpGet("summary")]
    [MapToApiVersion("2.0")]
    public ActionResult<Report> Summary()
    {
        return new Report { Id = 1, Title = "" };
    }
}

public sealed class Report
{
    public int Id { get; set; }
    public required string Title { get; set; }
}
