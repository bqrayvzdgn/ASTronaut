using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Dictionary<TKey, TValue> maps to an OBJECT with additionalProperties = value
// schema, rather than the previous empty OBJECT.
public class DictionaryTests
{
    private static string Controller(string prop) => $$"""
        using System.Collections.Generic;
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("x")]
        public class XController : ControllerBase
        {
            [HttpPost]
            public Bag Post([FromBody] Bag b) => b;
        }

        public class Item { public int Id { get; set; } }
        public class Bag { {{prop}} }
        """;

    [Fact]
    public void StringToPrimitive_UsesAdditionalProperties()
    {
        var result = TestCompilation.Walk(Controller("public Dictionary<string, int> Counts { get; set; } = new();"));
        var counts = result.SharedSchemas["Bag"].Properties!["counts"];

        Assert.Equal("OBJECT", counts.Kind);
        Assert.NotNull(counts.AdditionalProperties);
        Assert.Equal("integer", counts.AdditionalProperties!.PrimitiveType);
    }

    [Fact]
    public void StringToDto_ReferencesValueSchema()
    {
        var result = TestCompilation.Walk(Controller("public Dictionary<string, Item> Items { get; set; } = new();"));
        var items = result.SharedSchemas["Bag"].Properties!["items"];

        Assert.Equal("OBJECT", items.Kind);
        Assert.Equal("REFERENCE", items.AdditionalProperties!.Kind);
        Assert.Equal("Item", items.AdditionalProperties.RefName);
        Assert.True(result.SharedSchemas.ContainsKey("Item"));
    }
}
