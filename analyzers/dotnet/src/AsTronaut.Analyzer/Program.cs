using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using AsTronaut.Analyzer.Controllers;
using AsTronaut.Analyzer.Discovery;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.Logging;
using AsTronaut.Analyzer.SchemaInference;
using Google.Protobuf;
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
            if (args[i] == "--cwd")
            {
                if (i + 1 >= args.Length)
                {
                    StderrLog.Error("--cwd requires a path argument.");
                    return null;
                }
                repoRoot = args[i + 1];
                i++;
            }
            else
            {
                StderrLog.Error($"Unknown argument: {args[i]}");
                return null;
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
            var failure = new ParseResult
            {
                Errors = { loadResult.Diagnostics },
                Metadata = new ParserMetadata
                {
                    Framework = "aspnet",
                    FilesScanned = 0,
                    DurationMs = stopwatch.ElapsedMilliseconds,
                    ParserVersion = ParserVersion,
                },
            };
            WriteJson(failure);
            return 1;
        }

        var schemaContext = new SchemaContext();
        var routes = new List<RouteInfo>();
        var errors = new List<ParseError>(loadResult.Diagnostics);
        var filesScanned = 0;
        var scannedFiles = new HashSet<string>(StringComparer.Ordinal);
        var frameworkVersion = DetectFrameworkVersion(loadResult.Compilations.FirstOrDefault());

        foreach (var compilation in loadResult.Compilations)
        {
            var controllerWalker = new ControllerWalker(compilation, repoRoot, schemaContext);
            controllerWalker.Walk();

            routes.AddRange(controllerWalker.Routes);
            errors.AddRange(controllerWalker.Errors);
            foreach (var tree in compilation.SyntaxTrees)
            {
                if (scannedFiles.Add(tree.FilePath)) filesScanned++;
            }
        }

        var result = new ParseResult
        {
            Routes = { routes },
            Errors = { errors },
            Metadata = new ParserMetadata
            {
                Framework = "aspnet",
                FilesScanned = filesScanned,
                DurationMs = stopwatch.ElapsedMilliseconds,
                ParserVersion = ParserVersion,
            },
            SharedSchemas = { schemaContext.SharedSchemas },
        };
        if (frameworkVersion is not null)
        {
            result.Metadata.FrameworkVersion = frameworkVersion;
        }

        WriteJson(result);
        return 0;
    }

    private static string? DetectFrameworkVersion(Compilation? compilation)
    {
        if (compilation is null) return null;
        foreach (var reference in compilation.References)
        {
            var display = reference.Display;
            if (display is null) continue;
            if (!display.Contains("Microsoft.AspNetCore", StringComparison.Ordinal)) continue;
            var match = Regex.Match(display, @"Version=(\d+\.\d+\.\d+\.\d+)");
            if (match.Success) return match.Groups[1].Value;
        }
        return null;
    }

    private static void WriteJson(IMessage message)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonFormatter.Default.Format(message) + Environment.NewLine);
        using var stdout = Console.OpenStandardOutput();
        stdout.Write(bytes);
    }
}
