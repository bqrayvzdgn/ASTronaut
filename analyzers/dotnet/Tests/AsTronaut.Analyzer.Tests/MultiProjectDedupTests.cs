using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// R2/R6: a DTO shared across projects in a `.sln` must be hoisted into
// components/schemas exactly ONCE. Before the fix, dedup keyed on
// SymbolEqualityComparer, so the SAME type reached through a metadata reference
// (a distinct symbol) missed the cache and AllocateName's collision path emitted
// a duplicated, namespace-qualified second copy. The dedup key is now the type's
// structural fully-qualified name, which is stable across compilations.
public class MultiProjectDedupTests
{
    // Project A: defines Demo.Order and a controller returning it.
    private const string SharedProject = """
        using Microsoft.AspNetCore.Mvc;

        namespace Demo;

        [ApiController]
        [Route("orders")]
        public class OrdersController : ControllerBase
        {
            [HttpGet]
            public Order Get() => new();
        }

        public class Order
        {
            public int Id { get; set; }
            public string Name { get; set; } = "";
        }
        """;

    // Project B: references A's assembly and returns the SAME Demo.Order.
    private const string ConsumerProject = """
        using Microsoft.AspNetCore.Mvc;
        using Demo;

        namespace Consumer;

        [ApiController]
        [Route("mirror")]
        public class MirrorController : ControllerBase
        {
            [HttpGet]
            public Order Get() => new();
        }
        """;

    [Fact]
    public void SharedDto_AcrossProjects_IsHoistedOnce()
    {
        var result = TestCompilation.WalkMultiProject(SharedProject, ConsumerProject);

        // Exactly one schema for Order — the single "Order", with no duplicated
        // "DemoOrder"/"Order2" second copy from the collision path.
        var orderSchemas = result.SharedSchemas.Keys
            .Where(k => k.Contains("Order", StringComparison.Ordinal))
            .OrderBy(k => k, StringComparer.Ordinal)
            .ToList();

        Assert.Equal(new[] { "Order" }, orderSchemas);
    }

    [Fact]
    public void SharedDto_AcrossProjects_ConsumerRouteReferencesSameSchema()
    {
        var result = TestCompilation.WalkMultiProject(SharedProject, ConsumerProject);

        // The consumer's route response must point at the ONE hoisted "Order",
        // not at a namespace-qualified duplicate.
        var ok = result.Route("GET", "/mirror").Responses!.Single(r => r.Status == 200);
        Assert.Equal("REFERENCE", ok.Schema!.Kind);
        Assert.Equal("Order", ok.Schema.RefName);
    }

    [Fact]
    public void DifferentDtos_SameSimpleName_StayDistinct()
    {
        // Two genuinely different Order types (different namespaces) must NOT be
        // merged: the structural key includes the namespace, so they still split.
        var shared = """
            using Microsoft.AspNetCore.Mvc;

            namespace Ordering;

            [ApiController]
            [Route("a")]
            public class AController : ControllerBase
            {
                [HttpGet]
                public Order Get() => new();
            }

            public class Order { public int Id { get; set; } }
            """;
        var consumer = """
            using Microsoft.AspNetCore.Mvc;

            namespace Shipping;

            [ApiController]
            [Route("b")]
            public class BController : ControllerBase
            {
                [HttpGet]
                public Order Get() => new();
            }

            public class Order { public string Code { get; set; } = ""; }
            """;

        var result = TestCompilation.WalkMultiProject(shared, consumer);

        var orderSchemas = result.SharedSchemas.Keys
            .Where(k => k.Contains("Order", StringComparison.Ordinal))
            .ToList();

        Assert.Equal(2, orderSchemas.Count);
    }
}
