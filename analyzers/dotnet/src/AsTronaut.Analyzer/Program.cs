using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Discovery;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.Logging;
using AsTronaut.Analyzer.SchemaInference;
using Microsoft.Build.Locator;

namespace AsTronaut.Analyzer;

public static class Program
{
    private const string ParserVersion = "0.0.1";

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (!MSBuildLocator.IsRegistered)
            {
                MSBuildLocator.RegisterDefaults();
            }

            var parsed = ParseArgs(args);
            if (parsed is null) return 1;

            var (projectPath, repoRoot) = parsed.Value;
            return await AnalyzeAsync(projectPath, repoRoot);
        }
        catch (Exception ex)
        {
            StderrLog.Error($"Unhandled exception: {ex}");
            return 2;
        }
    }

    private static (string ProjectPath, string RepoRoot)? ParseArgs(string[] args)
    {
        if (args.Length == 0)
        {
            StderrLog.Error("Usage: AsTronaut.Analyzer <project-path-or-csproj> [--cwd <repo-root>]");
            return null;
        }
        var projectPath = args[0];
        var repoRoot = Directory.GetCurrentDirectory();
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--cwd" && i + 1 < args.Length)
            {
                repoRoot = args[i + 1];
                i++;
            }
        }
        return (projectPath, repoRoot);
    }

    private static async Task<int> AnalyzeAsync(string projectPath, string repoRoot)
    {
        var stopwatch = Stopwatch.StartNew();

        var loadResult = await ProjectLoader.LoadAsync(projectPath, repoRoot);
        if (loadResult.Compilations.Count == 0)
        {
            // Nothing to analyze. Still emit a valid ParseResult so the (E001)
            // load-failure diagnostics are visible on stdout and `--strict`
            // consumers can act on them; the exit code stays 1.
            var failure = new ParseResult
            {
                Errors = loadResult.Diagnostics.ToList(),
                Metadata = new ParserMetadata
                {
                    Framework = "aspnet",
                    FilesScanned = 0,
                    DurationMs = stopwatch.ElapsedMilliseconds,
                    ParserVersion = ParserVersion,
                },
            };
            Console.Out.WriteLine(JsonSerializer.Serialize(failure, BuildJsonOptions()));
            return 1;
        }

        // One shared SchemaContext across every project so a DTO used by more
        // than one project is hoisted exactly once.
        var schemaContext = new SchemaContext();
        var routes = new List<RouteInfo>();
        var errors = new List<ParseError>(loadResult.Diagnostics);
        var filesScanned = 0;

        foreach (var compilation in loadResult.Compilations)
        {
            var controllerWalker = new ControllerWalker(compilation, repoRoot, schemaContext);
            controllerWalker.Walk();

            routes.AddRange(controllerWalker.Routes);
            errors.AddRange(controllerWalker.Errors);
            filesScanned += compilation.SyntaxTrees.Count();
        }

        var result = new ParseResult
        {
            Routes = routes,
            Errors = errors,
            Metadata = new ParserMetadata
            {
                Framework = "aspnet",
                FilesScanned = filesScanned,
                DurationMs = stopwatch.ElapsedMilliseconds,
                ParserVersion = ParserVersion,
            },
            SharedSchemas = schemaContext.SharedSchemas.Count > 0
                ? schemaContext.SharedSchemas
                : null,
        };

        var json = JsonSerializer.Serialize(result, BuildJsonOptions());
        Console.Out.WriteLine(json);
        return 0;
    }

    private static JsonSerializerOptions BuildJsonOptions()
    {
        return new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false,
        };
    }
}
