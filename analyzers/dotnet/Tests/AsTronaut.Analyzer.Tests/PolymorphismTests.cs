using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// [JsonPolymorphic] + [JsonDerivedType] map a base type to a discriminated
// ONE_OF: variants reference each derived schema, plus a discriminator mapping.
public class PolymorphismTests
{
    private const string Source = """
        using Microsoft.AspNetCore.Mvc;
        using System.Text.Json.Serialization;
        namespace Demo;

        [ApiController]
        [Route("animals")]
        public class AnimalsController : ControllerBase
        {
            [HttpPost]
            public Animal Post([FromBody] Animal a) => a;
        }

        [JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
        [JsonDerivedType(typeof(Dog), "dog")]
        [JsonDerivedType(typeof(Cat), "cat")]
        public abstract class Animal { public string Name { get; set; } = ""; }

        public sealed class Dog : Animal { public bool GoodBoy { get; set; } }
        public sealed class Cat : Animal { public int Lives { get; set; } }
        """;

    [Fact]
    public void PolymorphicBase_BecomesOneOfWithDiscriminator()
    {
        var result = TestCompilation.Walk(Source);
        var animal = result.SharedSchemas["Animal"];

        Assert.Equal("ONE_OF", animal.Kind);
        Assert.Equal("kind", animal.Discriminator);
        Assert.NotNull(animal.Variants);
        Assert.Equal(2, animal.Variants!.Count);
        Assert.All(animal.Variants, v => Assert.Equal("REFERENCE", v.Kind));

        Assert.NotNull(animal.DiscriminatorMapping);
        Assert.Equal("Dog", animal.DiscriminatorMapping!["dog"]);
        Assert.Equal("Cat", animal.DiscriminatorMapping["cat"]);
    }

    [Fact]
    public void DerivedSchemas_IncludeInheritedProperties()
    {
        var result = TestCompilation.Walk(Source);

        var dog = result.SharedSchemas["Dog"];
        Assert.Equal("OBJECT", dog.Kind);
        Assert.Contains("name", dog.Properties!.Keys);   // inherited from Animal
        Assert.Contains("goodBoy", dog.Properties.Keys); // declared on Dog
    }
}
