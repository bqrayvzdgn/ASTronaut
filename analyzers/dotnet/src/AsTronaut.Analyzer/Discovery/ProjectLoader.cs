using AsTronaut.Analyzer.Logging;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace AsTronaut.Analyzer.Discovery;

// Resolves an input path (directory or .csproj) into a Roslyn Compilation by
// opening the project through MSBuildWorkspace.
public static class ProjectLoader
{
    public static async Task<Compilation?> LoadAsync(string inputPath)
    {
        var csprojPath = ResolveCsproj(inputPath);
        if (csprojPath is null) return null;

        StderrLog.Info($"Loading project: {csprojPath}");

        using var workspace = MSBuildWorkspace.Create();
        workspace.WorkspaceFailed += (_, e) =>
        {
            if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure)
            {
                StderrLog.Warn($"workspace: {e.Diagnostic.Message}");
            }
        };

        var project = await workspace.OpenProjectAsync(csprojPath);
        return await project.GetCompilationAsync();
    }

    public static string? ResolveCsproj(string inputPath)
    {
        if (File.Exists(inputPath))
        {
            if (inputPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                return Path.GetFullPath(inputPath);
            }
            StderrLog.Error($"Input is a file but not a .csproj: {inputPath}");
            return null;
        }
        if (!Directory.Exists(inputPath))
        {
            StderrLog.Error($"Input path does not exist: {inputPath}");
            return null;
        }
        var matches = Directory.EnumerateFiles(inputPath, "*.csproj", SearchOption.AllDirectories)
            .Where(p => !p.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                        && !p.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            .ToList();
        if (matches.Count == 0)
        {
            StderrLog.Error($"No .csproj files found under: {inputPath}");
            return null;
        }
        if (matches.Count > 1)
        {
            StderrLog.Warn($"Multiple .csproj files found; using the first: {matches[0]}");
        }
        return Path.GetFullPath(matches[0]);
    }
}
