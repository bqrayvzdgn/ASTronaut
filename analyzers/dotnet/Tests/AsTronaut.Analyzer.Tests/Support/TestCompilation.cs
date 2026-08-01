using System.Collections.Immutable;
using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace AsTronaut.Analyzer.Tests.Support;

// Builds an in-memory Roslyn Compilation from a C# source string and runs the
// walkers against it — no MSBuild, no subprocess, so tests are fast and
// deterministic. The reference set is the test host's trusted platform
// assemblies, which include Microsoft.AspNetCore.App thanks to the
// <FrameworkReference> in the test csproj.
public static class TestCompilation
{
    private static readonly Lazy<ImmutableArray<MetadataReference>> References =
        new(LoadTrustedPlatformReferences);

    // Fixed virtual path so SourceLocation.File is stable across machines.
    public const string SourcePath = "Test.cs";

    public static Compilation Create(string source)
    {
        var tree = CSharpSyntaxTree.ParseText(
            source,
            new CSharpParseOptions(LanguageVersion.Latest),
            path: SourcePath);

        return CSharpCompilation.Create(
            assemblyName: "AsTronaut.Analyzer.TestInput",
            syntaxTrees: new[] { tree },
            references: References.Value,
            options: new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));
    }

    // Convenience: run the controller walker over the source with a shared
    // SchemaContext (mirrors Program.AnalyzeAsync) and return the assembled result.
    public static WalkResult Walk(string source, string repoRoot = "")
    {
        var compilation = Create(source);
        var schemaContext = new SchemaContext();

        var controllers = new ControllerWalker(compilation, repoRoot, schemaContext);
        controllers.Walk();

        var routes = controllers.Routes.ToList();
        var errors = controllers.Errors.ToList();
        return new WalkResult(routes, errors, schemaContext.SharedSchemas);
    }

    private static ImmutableArray<MetadataReference> LoadTrustedPlatformReferences()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? "";
        var builder = ImmutableArray.CreateBuilder<MetadataReference>();
        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (path.Length == 0 || !File.Exists(path)) continue;
            builder.Add(MetadataReference.CreateFromFile(path));
        }
        return builder.ToImmutable();
    }
}

public sealed record WalkResult(
    IReadOnlyList<RouteInfo> Routes,
    IReadOnlyList<ParseError> Errors,
    IReadOnlyDictionary<string, Schema> SharedSchemas)
{
    public RouteInfo Route(string method, string path) =>
        Routes.Single(r =>
            string.Equals(r.Method, method, StringComparison.OrdinalIgnoreCase) &&
            r.Path == path);

    // Property keys of a shared (hoisted) DTO schema by ref name.
    public IReadOnlyCollection<string> SchemaPropertyKeys(string refName) =>
        SharedSchemas.TryGetValue(refName, out var schema) && schema.Properties is not null
            ? schema.Properties.Keys.ToList()
            : Array.Empty<string>();
}
