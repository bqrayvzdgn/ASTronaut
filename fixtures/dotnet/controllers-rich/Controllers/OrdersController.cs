using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ControllersRich.Controllers;

[ApiController]
[Route("api/orders")]
[Authorize]
public class OrdersController : ControllerBase
{
    /// <summary>List orders for the current customer.</summary>
    /// <remarks>Results are paginated; use <c>page</c> and <c>size</c>.</remarks>
    /// <param name="page">1-based page number.</param>
    /// <param name="size">Items per page (1-100).</param>
    [HttpGet]
    [ProducesResponseType(typeof(List<Order>), 200)]
    public ActionResult<List<Order>> List(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        return new List<Order>();
    }

    /// <summary>Fetch a single order.</summary>
    /// <param name="id">The order identifier.</param>
    [HttpGet("{id:guid}")]
    [ProducesResponseType(typeof(Order), 200)]
    [ProducesResponseType(404)]
    public ActionResult<Order> Get(Guid id)
    {
        return new Order { Id = id, CustomerEmail = "" };
    }

    /// <summary>Create a new order.</summary>
    [HttpPost]
    [ProducesResponseType(typeof(Order), 201)]
    [ProducesResponseType(400)]
    public ActionResult<Order> Create([FromBody] CreateOrderDto dto)
    {
        return new Order { Id = Guid.NewGuid(), CustomerEmail = dto.CustomerEmail };
    }

    /// <summary>Public health check — no auth required.</summary>
    [AllowAnonymous]
    [HttpGet("/health")]
    [ProducesResponseType(200)]
    public IActionResult Health() => Ok();
}

public sealed class Order
{
    public Guid Id { get; set; }

    [Required]
    [EmailAddress]
    public required string CustomerEmail { get; set; }

    [Range(0.01, 1000000)]
    public decimal Total { get; set; }

    public string? Notes { get; set; }
}

public sealed class CreateOrderDto
{
    [Required]
    [EmailAddress]
    [StringLength(120, MinimumLength = 3)]
    public required string CustomerEmail { get; set; }

    [Range(0.01, 1000000)]
    public decimal Total { get; set; }

    [RegularExpression("^[A-Z]{3}$")]
    public string Currency { get; set; } = "USD";

    [MaxLength(500)]
    public string? Notes { get; set; }
}
