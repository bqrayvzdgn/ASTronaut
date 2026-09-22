using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;

namespace ControllersFeatures.Controllers;

// Grup 1 binding & schema fidelity on a real compilation:
//   E12 [AsParameters] flatten · E3 Name overrides · E15/J2 enum query param ·
//   G36 [ProducesResponseType] completed from the body · I3 record struct ·
//   L3b/L15 [MaxLength] on a collection vs a string · I29 snake_case names.
[ApiController]
[Route("api/products")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(200)]
    public IActionResult List(
        [AsParameters] ProductQuery query,
        [FromHeader(Name = "X-Tenant-Id")] string tenantId)
    {
        return Ok(new List<Product>());
    }

    [HttpGet("{id:int}")]
    public ActionResult<Product> Get(
        int id,
        [FromQuery(Name = "include_archived")] bool includeArchived = false)
    {
        return new Product { Id = id, Sku = "" };
    }

    [HttpGet("by-status")]
    public ActionResult<List<Product>> ByStatus([FromQuery] ProductStatus status)
    {
        return new List<Product>();
    }
}

public sealed class ProductQuery
{
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
    public string? Search { get; set; }
}

public enum ProductStatus
{
    Draft,
    Active,
    Archived,
}

public sealed class Product
{
    public int Id { get; set; }

    [MaxLength(50)]
    public required string Sku { get; set; }

    [MaxLength(10)]
    public string[] Tags { get; set; } = [];

    public ProductStatus Status { get; set; }

    public Money Price { get; set; }

    public string? DisplayName { get; set; }
}

public readonly record struct Money(decimal Amount, string Currency);
