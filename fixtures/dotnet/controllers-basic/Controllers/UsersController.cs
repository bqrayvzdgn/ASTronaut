using Microsoft.AspNetCore.Mvc;

namespace ControllersBasic.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    [HttpGet]
    public ActionResult<List<User>> List()
    {
        return new List<User>();
    }

    [HttpGet("{id}")]
    public ActionResult<User> Get(int id)
    {
        return new User { Id = id, Email = "" };
    }

    [HttpPost]
    public ActionResult<User> Create([FromBody] CreateUserDto dto)
    {
        return new User { Id = 1, Email = dto.Email };
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(int id)
    {
        return NoContent();
    }
}

public sealed class User
{
    public int Id { get; set; }
    public required string Email { get; set; }
    public string? Name { get; set; }
}

public sealed class CreateUserDto
{
    public required string Email { get; set; }
    public int Age { get; set; }
}
