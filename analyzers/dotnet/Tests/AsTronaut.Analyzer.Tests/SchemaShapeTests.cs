using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Priority-2 DTO coverage: positional records, generic DTOs, and file uploads
// (IFormFile / [FromForm] → multipart/form-data with binary schema).
public class SchemaShapeTests
{
    [Fact]
    public void PositionalRecord_BecomesObjectWithProperties()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("todos")]
            public class TodosController : ControllerBase
            {
                [HttpPost]
                public Todo Create([FromBody] Todo t) => t;
            }

            public record Todo(int Id, string Title);
            """);

        Assert.True(result.SharedSchemas.TryGetValue("Todo", out var schema));
        Assert.Equal("OBJECT", schema!.Kind);
        var keys = result.SchemaPropertyKeys("Todo");
        Assert.Contains("id", keys);
        Assert.Contains("title", keys);
    }

    [Fact]
    public void GenericDto_ResolvesTypeArgument_IntoDistinctSchema()
    {
        var result = TestCompilation.Walk("""
            using System.Collections.Generic;
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("items")]
            public class ItemsController : ControllerBase
            {
                [HttpGet]
                public Page<Item> List() => new Page<Item>();
            }

            public class Page<T> { public List<T> Items { get; set; } = new(); public int Total { get; set; } }
            public class Item { public int Id { get; set; } }
            """);

        // Page<Item> is hoisted; its Items array element resolves to Item.
        Assert.True(result.SharedSchemas.ContainsKey("Page"));
        Assert.True(result.SharedSchemas.ContainsKey("Item"));
        var page = result.SharedSchemas["Page"];
        var items = page.Properties!["items"];
        Assert.Equal("ARRAY", items.Kind);
        Assert.Equal("REFERENCE", items.Items!.Kind);
        Assert.Equal("Item", items.Items.RefName);
    }

    [Fact]
    public void StructDto_BecomesObjectWithProperties()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("points")]
            public class PointsController : ControllerBase
            {
                [HttpPost]
                public Point Create([FromBody] Point p) => p;
            }

            public struct Point { public int X { get; set; } public int Y { get; set; } }
            """);

        // A user-defined struct DTO must hoist as an OBJECT with its properties,
        // exactly like a class — not collapse to an empty {} fallback.
        Assert.True(result.SharedSchemas.TryGetValue("Point", out var schema));
        Assert.Equal("OBJECT", schema!.Kind);
        var keys = result.SchemaPropertyKeys("Point");
        Assert.Contains("x", keys);
        Assert.Contains("y", keys);
    }

    [Fact]
    public void RecordStructDto_BecomesObjectWithProperties()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("money")]
            public class MoneyController : ControllerBase
            {
                [HttpPost]
                public Money Create([FromBody] Money m) => m;
            }

            public readonly record struct Money(decimal Amount, string Currency);
            """);

        Assert.True(result.SharedSchemas.TryGetValue("Money", out var schema));
        Assert.Equal("OBJECT", schema!.Kind);
        var keys = result.SchemaPropertyKeys("Money");
        Assert.Contains("amount", keys);
        Assert.Contains("currency", keys);
    }

    [Fact]
    public void IFormFile_MapsToBinary_WithMultipartContentType()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Http;
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("files")]
            public class FilesController : ControllerBase
            {
                [HttpPost]
                public string Upload(IFormFile file) => file.FileName;
            }
            """);

        var route = result.Route("POST", "/files");
        Assert.NotNull(route.RequestBody);
        Assert.Equal("multipart/form-data", route.RequestBody!.ContentType);
        Assert.Equal("string", route.RequestBody.Schema.PrimitiveType);
        Assert.Equal("binary", route.RequestBody.Schema.Format);
    }

    [Fact]
    public void FromFormComplexType_UsesMultipart()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Http;
            using Microsoft.AspNetCore.Mvc;
            namespace Demo;

            [ApiController]
            [Route("upload")]
            public class UploadController : ControllerBase
            {
                [HttpPost]
                public string Post([FromForm] UploadDto dto) => "ok";
            }

            public class UploadDto { public string Title { get; set; } = ""; public IFormFile File { get; set; } = null!; }
            """);

        var route = result.Route("POST", "/upload");
        Assert.Equal("multipart/form-data", route.RequestBody!.ContentType);
    }
}
