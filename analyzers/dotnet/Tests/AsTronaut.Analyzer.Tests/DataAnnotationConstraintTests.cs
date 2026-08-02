using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Locks in the *values* emitted by DataAnnotationReader for each supported
// System.ComponentModel.DataAnnotations attribute. Prior to these tests only the
// presence of format/constraint plumbing was covered — never the concrete
// numbers/strings produced.
//
// The collection-vs-string cases (Tags/Categories/Scores/Password) pin the
// L3b/L15 fix: MinLength/MaxLength/Length are dual-purpose in .NET — they mean
// string length on a string but item count on a collection — so the emitted
// constraint must depend on the target type.
public class DataAnnotationConstraintTests
{
    // A single DTO exercising every annotation. Bound as a request body so it is
    // hoisted into SharedSchemas["Dto"], where each property schema can be read.
    private const string Source = """
        using Microsoft.AspNetCore.Mvc;
        using System.ComponentModel.DataAnnotations;

        namespace Demo;

        [ApiController]
        [Route("dto")]
        public class DtoController : ControllerBase
        {
            [HttpPost]
            public Dto Post([FromBody] Dto dto) => dto;
        }

        public class Dto
        {
            [Required]
            public string Name { get; set; } = "";

            [StringLength(50, MinimumLength = 3)]
            public string Title { get; set; } = "";

            [Range(1, 100)]
            public int Count { get; set; }

            [RegularExpression("^[a-z]+$")]
            public string Code { get; set; } = "";

            [EmailAddress]
            public string Email { get; set; } = "";

            // string target → string-length semantics
            [MaxLength(20)]
            public string Slug { get; set; } = "";

            // string target → string-length semantics (Length = min/max)
            [Length(3, 10)]
            public string Password { get; set; } = "";

            // collection target → item-count semantics (L3b)
            [MaxLength(10)]
            public string[] Tags { get; set; } = System.Array.Empty<string>();

            // collection target → item-count semantics (L3b)
            [MinLength(2)]
            public string[] Categories { get; set; } = System.Array.Empty<string>();

            // collection target → item-count semantics (L15)
            [Length(1, 5)]
            public int[] Scores { get; set; } = System.Array.Empty<int>();
        }
        """;

    private static AsTronaut.Analyzer.Ir.Schema Prop(string name)
    {
        var result = TestCompilation.Walk(Source);
        return result.SharedSchemas["Dto"].Properties![name];
    }

    [Fact]
    public void Required_MarksPropertyRequired()
    {
        var result = TestCompilation.Walk(Source);
        var dto = result.SharedSchemas["Dto"];
        Assert.Contains("name", dto.RequiredProperties!);
    }

    [Fact]
    public void StringLength_EmitsMinAndMaxLength()
    {
        var title = Prop("title");
        Assert.Equal(3, title.Constraints!.MinLength);
        Assert.Equal(50, title.Constraints!.MaxLength);
    }

    [Fact]
    public void Range_EmitsMinimumAndMaximum()
    {
        var count = Prop("count");
        Assert.Equal(1, count.Constraints!.Minimum);
        Assert.Equal(100, count.Constraints!.Maximum);
    }

    [Fact]
    public void RegularExpression_EmitsPattern()
    {
        var code = Prop("code");
        Assert.Equal("^[a-z]+$", code.Constraints!.Pattern);
    }

    [Fact]
    public void EmailAddress_EmitsEmailFormat()
    {
        var email = Prop("email");
        Assert.Equal("email", email.Format);
    }

    // ---- collection-vs-string distinction (L3b / L15) ----

    [Fact]
    public void MaxLength_OnString_EmitsMaxLength_NotMaxItems()
    {
        var slug = Prop("slug");
        Assert.Equal(20, slug.Constraints!.MaxLength);
        Assert.Null(slug.Constraints!.MaxItems);
    }

    [Fact]
    public void Length_OnString_EmitsStringLength_NotItems()
    {
        var pwd = Prop("password");
        Assert.Equal(3, pwd.Constraints!.MinLength);
        Assert.Equal(10, pwd.Constraints!.MaxLength);
        Assert.Null(pwd.Constraints!.MinItems);
        Assert.Null(pwd.Constraints!.MaxItems);
    }

    [Fact]
    public void MaxLength_OnCollection_EmitsMaxItems_NotMaxLength()
    {
        var tags = Prop("tags");
        Assert.Equal("ARRAY", tags.Kind);
        Assert.Equal(10, tags.Constraints!.MaxItems);
        Assert.Null(tags.Constraints!.MaxLength);
    }

    [Fact]
    public void MinLength_OnCollection_EmitsMinItems_NotMinLength()
    {
        var categories = Prop("categories");
        Assert.Equal("ARRAY", categories.Kind);
        Assert.Equal(2, categories.Constraints!.MinItems);
        Assert.Null(categories.Constraints!.MinLength);
    }

    [Fact]
    public void Length_OnCollection_EmitsItems_NotStringLength()
    {
        var scores = Prop("scores");
        Assert.Equal("ARRAY", scores.Kind);
        Assert.Equal(1, scores.Constraints!.MinItems);
        Assert.Equal(5, scores.Constraints!.MaxItems);
        Assert.Null(scores.Constraints!.MinLength);
        Assert.Null(scores.Constraints!.MaxLength);
    }
}
