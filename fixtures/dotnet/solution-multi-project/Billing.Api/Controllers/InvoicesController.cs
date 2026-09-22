using Contracts;
using Microsoft.AspNetCore.Mvc;

namespace Billing.Api.Controllers;

[ApiController]
[Route("api/invoices")]
public class InvoicesController : ControllerBase
{
    [HttpGet("{id:int}")]
    public ActionResult<Invoice> Get(int id)
    {
        return new Invoice { Id = id, Customer = new Customer { Id = 1, Email = "" } };
    }
}

public sealed class Invoice
{
    public int Id { get; set; }
    public required Customer Customer { get; set; }
    public decimal Amount { get; set; }
}
