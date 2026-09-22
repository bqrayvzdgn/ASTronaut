using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Q7: the emitted document must not depend on the order MSBuild hands documents
// to the analyzer — that order differs by OS and file system and would make
// golden e2e output flaky across machines. Order inside a file stays source order.
public class DeterminismTests
{
    private const string ZebraController = """
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("zebra")]
        public class ZebraController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }
        """;

    private const string AppleController = """
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("apple")]
        public class AppleController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }
        """;

    private const string BothControllersZebraFirst = """
        using Microsoft.AspNetCore.Mvc;
        namespace Demo;

        [ApiController]
        [Route("zebra")]
        public class ZebraController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }

        [ApiController]
        [Route("apple")]
        public class AppleController : ControllerBase
        {
            [HttpGet]
            public IActionResult List() => Ok();
        }
        """;

    [Fact]
    public void Walk_FilesGivenInReverseOrder_EmitsRoutesInFilePathOrder()
    {
        // Arrange: the compilation receives the files in the "wrong" order.
        var result = TestCompilation.WalkFiles(
            ("Controllers/Zebra.cs", ZebraController),
            ("Controllers/Apple.cs", AppleController));

        // Act
        var paths = result.Routes.Select(r => r.Path).ToList();

        // Assert: Ordinal file-path order wins over insertion order.
        Assert.Equal(new[] { "/apple", "/zebra" }, paths);
    }

    [Fact]
    public void Walk_ControllersInOneFile_KeepsSourceOrder()
    {
        // Arrange: Zebra is declared before Apple inside a single file.
        var result = TestCompilation.WalkFiles(("Controllers/Both.cs", BothControllersZebraFirst));

        // Act
        var paths = result.Routes.Select(r => r.Path).ToList();

        // Assert
        Assert.Equal(new[] { "/zebra", "/apple" }, paths);
    }
}
