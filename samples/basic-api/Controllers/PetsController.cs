using Microsoft.AspNetCore.Mvc;

namespace BasicApi.Controllers;

public record Pet(int Id, string Name);

public record CreatePetRequest(string Name);

[ApiController]
[Route("api/pets")]
public class PetsController : ControllerBase
{
    [HttpGet]
    public ActionResult<IEnumerable<Pet>> List() => Ok(Array.Empty<Pet>());

    [HttpGet("{id:int}")]
    public ActionResult<Pet> Get(int id) => Ok(new Pet(id, "Rex"));

    [HttpPost]
    public ActionResult<Pet> Create([FromBody] CreatePetRequest request) =>
        CreatedAtAction(nameof(Get), new { id = 1 }, new Pet(1, request.Name));
}
