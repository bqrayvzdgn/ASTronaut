using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ControllersFeatures.Controllers;

// K2/K3/K8: [JsonPolymorphic]/[JsonDerivedType] → oneOf + custom discriminator,
// referenced through the base type. M19: an oauth2 scheme must be emitted with
// a `flows` object to be 3.1-valid.
[ApiController]
[Route("api/shapes")]
[Authorize(AuthenticationSchemes = "OAuth2")]
public class ShapesController : ControllerBase
{
    [HttpGet("{id:guid}")]
    public ActionResult<Shape> Get(Guid id)
    {
        Shape shape = new Circle { Id = id, Radius = 1 };
        return shape;
    }

    [HttpPost]
    public ActionResult<Shape> Create([FromBody] Shape shape)
    {
        return shape;
    }
}

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(Circle), "circle")]
[JsonDerivedType(typeof(Rectangle), "rectangle")]
public abstract class Shape
{
    public Guid Id { get; set; }
}

public sealed class Circle : Shape
{
    public double Radius { get; set; }
}

public sealed class Rectangle : Shape
{
    public double Width { get; set; }
    public double Height { get; set; }
}
