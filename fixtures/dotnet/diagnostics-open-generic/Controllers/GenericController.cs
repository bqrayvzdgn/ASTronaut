using Microsoft.AspNetCore.Mvc;

namespace DiagnosticsOpenGeneric.Controllers;

// An OPEN generic controller has an unbound T: no route can be emitted for it.
// The analyzer must skip it with a W004 warning instead of dropping it silently
// (B13). The concrete ItemsController next to it must be unaffected.
[ApiController]
[Route("api/generic")]
public class GenericController<T> : ControllerBase
    where T : class, new()
{
    [HttpGet]
    public ActionResult<T> Get()
    {
        return new T();
    }
}
