using Contracts;
using Microsoft.AspNetCore.Mvc;

namespace Orders.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    public ActionResult<Order> Get(int id)
    {
        return new Order { Id = id, Customer = new Customer { Id = 1, Email = "" } };
    }
}

public sealed class Order
{
    public int Id { get; set; }
    public required Customer Customer { get; set; }
    public decimal Total { get; set; }
}
