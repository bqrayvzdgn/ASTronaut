using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Diagnostics;
using AsTronaut.Analyzer.Discovery;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.Logging;
using AsTronaut.Analyzer.MinimalApi;
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
        var controllerRoutes = new List<RouteInfo>();
        var minimalRoutes = new List<RouteInfo>();
        var errors = new List<ParseError>(loadResult.Diagnostics);
        var filesScanned = 0;

        foreach (var compilation in loadResult.Compilations)
        {
            var controllerWalker = new ControllerWalker(compilation, repoRoot, schemaContext);
            controllerWalker.Walk();

            var minimalWalker = new MinimalApiWalker(compilation, repoRoot, schemaContext);
            minimalWalker.Walk();

            controllerRoutes.AddRange(controllerWalker.Routes);
            minimalRoutes.AddRange(minimalWalker.Routes);
            errors.AddRange(controllerWalker.Errors);
            errors.AddRange(minimalWalker.Errors);
            filesScanned += compilation.SyntaxTrees.Count();
        }

        var routes = MergeRoutes(controllerRoutes, minimalRoutes, errors);

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

    // Controller routes win over minimal-API routes on an exact (Method, Path)
    // collision across the two sources: the same endpoint surfaced by both walkers
    // would otherwise be emitted twice. Duplicates within a single source are left
    // untouched — those are genuinely distinct declarations for a downstream layer
    // to reconcile, not a walker double-count.
    private static List<RouteInfo> MergeRoutes(
        List<RouteInfo> controllerRoutes, List<RouteInfo> minimalRoutes, List<ParseError> errors)
    {
        var merged = new List<RouteInfo>(controllerRoutes);
        var controllerKeys = new HashSet<string>(controllerRoutes.Select(RouteKey));

        foreach (var route in minimalRoutes)
        {
            if (controllerKeys.Contains(RouteKey(route)))
            {
                errors.Add(new ParseError
                {
                    File = route.Source.File,
                    Line = route.Source.Line,
                    Message = $"Duplicate route {route.Method} {route.Path} emitted by both the controller and minimal-API walkers; dropped the minimal-API duplicate.",
                    Severity = "warning",
                    Code = DiagnosticCodes.DuplicateRoute,
                });
                continue;
            }
            merged.Add(route);
        }
        return merged;
    }

    private static string RouteKey(RouteInfo route) =>
        $"{route.Method.ToUpperInvariant()} {route.Path}";

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
