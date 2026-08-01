using AsTronaut.Analyzer.Diagnostics;
using AsTronaut.Analyzer.Ir;
using AsTronaut.Analyzer.Logging;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace AsTronaut.Analyzer.Discovery;

// Outcome of loading input: one Roslyn Compilation per C# project (a single
// entry for a .csproj, potentially many for a .sln), plus any structured
// diagnostics gathered while loading (e.g. MSBuild workspace failures, which
// otherwise would only reach stderr). Empty Compilations = hard failure.
public sealed record ProjectLoadResult(
    IReadOnlyList<Compilation> Compilations,
    IReadOnlyList<ParseError> Diagnostics);

// Resolves an input path (directory, .csproj, or .sln/.slnx) into one or more
// Roslyn Compilations by opening it through MSBuildWorkspace. A solution loads
// every C# project so that API surface spread across projects is all analyzed.
public static class ProjectLoader
{
    private enum InputKind { Project, Solution }

    public static async Task<ProjectLoadResult> LoadAsync(string inputPath, string repoRoot = "")
    {
        var diagnostics = new List<ParseError>();

        var resolved = ResolveInput(inputPath);
        if (resolved is null) return new ProjectLoadResult(Array.Empty<Compilation>(), diagnostics);

        var (kind, path) = resolved.Value;
        StderrLog.Info($"Loading {(kind == InputKind.Solution ? "solution" : "project")}: {path}");
        var displayPath = NormalizePath(path, repoRoot);

        using var workspace = MSBuildWorkspace.Create();
        workspace.WorkspaceFailed += (_, e) =>
        {
            if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure)
            {
                StderrLog.Warn($"workspace: {e.Diagnostic.Message}");
                diagnostics.Add(new ParseError
                {
                    File = displayPath,
                    Line = 0,
                    Message = $"Project load: {e.Diagnostic.Message}",
                    Severity = "warning",
                    Code = DiagnosticCodes.WorkspaceLoad,
                });
            }
        };

        var projects = kind == InputKind.Solution
            ? (await workspace.OpenSolutionAsync(path)).Projects
            : new[] { await workspace.OpenProjectAsync(path) };

        var compilations = new List<Compilation>();
        foreach (var project in projects)
        {
            if (project.Language != LanguageNames.CSharp) continue;
            var compilation = await project.GetCompilationAsync();
            if (compilation is not null) compilations.Add(compilation);
        }
        return new ProjectLoadResult(compilations, diagnostics);
    }

    private static string NormalizePath(string path, string repoRoot)
    {
        if (string.IsNullOrEmpty(path)) return path;
        if (string.IsNullOrEmpty(repoRoot)) return path.Replace('\\', '/');
        try
        {
            return Path.GetRelativePath(repoRoot, path).Replace('\\', '/');
        }
        catch
        {
            return path.Replace('\\', '/');
        }
    }

    private static bool IsSolutionExt(string p) =>
        p.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
        || p.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase);

    private static (InputKind Kind, string Path)? ResolveInput(string inputPath)
    {
        if (File.Exists(inputPath))
        {
            if (IsSolutionExt(inputPath))
                return (InputKind.Solution, Path.GetFullPath(inputPath));
            if (inputPath.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
                return (InputKind.Project, Path.GetFullPath(inputPath));
            StderrLog.Error($"Input is a file but not a .csproj/.sln: {inputPath}");
            return null;
        }
        if (!Directory.Exists(inputPath))
        {
            StderrLog.Error($"Input path does not exist: {inputPath}");
            return null;
        }

        // A solution takes precedence: it captures multi-project surface that a
        // single .csproj would miss.
        var solutions = EnumerateSource(inputPath, "*.sln")
            .Concat(EnumerateSource(inputPath, "*.slnx"))
            .ToList();
        if (solutions.Count > 0)
        {
            if (solutions.Count > 1)
                StderrLog.Warn($"Multiple solution files found; using the first: {solutions[0]}");
            return (InputKind.Solution, Path.GetFullPath(solutions[0]));
        }

        var projects = EnumerateSource(inputPath, "*.csproj").ToList();
        if (projects.Count == 0)
        {
            StderrLog.Error($"No .csproj or .sln files found under: {inputPath}");
            return null;
        }
        if (projects.Count > 1)
            StderrLog.Warn($"Multiple .csproj files found (and no solution); using the first: {projects[0]}");
        return (InputKind.Project, Path.GetFullPath(projects[0]));
    }

    private static IEnumerable<string> EnumerateSource(string dir, string pattern) =>
        Directory.EnumerateFiles(dir, pattern, SearchOption.AllDirectories)
            .Where(p => !p.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                        && !p.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"));
}
