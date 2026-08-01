using System.Xml.Linq;
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

        var resolved = ResolveInput(inputPath, diagnostics, repoRoot);
        if (resolved is null)
        {
            diagnostics.Add(new ParseError
            {
                File = NormalizePath(inputPath, repoRoot),
                Line = 0,
                Message = $"Could not resolve a project or solution to analyze from input: {inputPath}",
                Severity = "error",
                Code = DiagnosticCodes.ProjectLoadFailed,
            });
            return new ProjectLoadResult(Array.Empty<Compilation>(), diagnostics);
        }

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

        IReadOnlyList<Project> projects = kind == InputKind.Solution
            ? await OpenSolutionProjectsAsync(workspace, path, diagnostics, repoRoot)
            : new[] { await workspace.OpenProjectAsync(path) };

        var compilations = new List<Compilation>();
        foreach (var project in projects)
        {
            if (project.Language != LanguageNames.CSharp) continue;
            var compilation = await project.GetCompilationAsync();
            if (compilation is not null) compilations.Add(compilation);
        }

        if (compilations.Count == 0)
        {
            diagnostics.Add(new ParseError
            {
                File = displayPath,
                Line = 0,
                Message = $"No C# compilation could be produced from: {displayPath}",
                Severity = "error",
                Code = DiagnosticCodes.ProjectLoadFailed,
            });
        }
        return new ProjectLoadResult(compilations, diagnostics);
    }

    // Resolves the C# projects of a solution. `.slnx` (the XML solution format)
    // is parsed directly because not every bundled MSBuild can open it; classic
    // `.sln` goes through the workspace. Either way, if the solution can't be
    // resolved we fall back to opening every `.csproj` under its directory so a
    // solution is never a hard failure.
    private static async Task<IReadOnlyList<Project>> OpenSolutionProjectsAsync(
        MSBuildWorkspace workspace, string path, List<ParseError> diagnostics, string repoRoot)
    {
        if (path.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase))
        {
            var refs = ParseSlnxProjectPaths(path);
            if (refs.Count > 0) return await OpenProjectsAsync(workspace, refs);
        }
        else
        {
            try
            {
                var solution = await workspace.OpenSolutionAsync(path);
                return solution.Projects.ToList();
            }
            catch (Exception ex)
            {
                StderrLog.Warn($"solution parse failed ({ex.GetType().Name}); scanning for .csproj instead");
            }
        }

        var dir = Path.GetDirectoryName(path) ?? ".";
        diagnostics.Add(new ParseError
        {
            File = NormalizePath(path, repoRoot),
            Line = 0,
            Message = "Solution file could not be opened directly; analyzed the .csproj files found under its directory instead.",
            Severity = "warning",
            Code = DiagnosticCodes.WorkspaceLoad,
        });
        var fallbackCsprojs = EnumerateSource(dir, "*.csproj").ToList();
        fallbackCsprojs.Sort(StringComparer.Ordinal);
        return await OpenProjectsAsync(workspace, fallbackCsprojs);
    }

    private static List<string> ParseSlnxProjectPaths(string slnxPath)
    {
        var result = new List<string>();
        try
        {
            var doc = XDocument.Load(slnxPath);
            var dir = Path.GetDirectoryName(slnxPath) ?? ".";
            foreach (var proj in doc.Descendants("Project"))
            {
                var rel = proj.Attribute("Path")?.Value;
                if (string.IsNullOrEmpty(rel)) continue;
                var full = Path.GetFullPath(Path.Combine(dir, rel.Replace('\\', Path.DirectorySeparatorChar)));
                if (File.Exists(full) && full.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
                {
                    result.Add(full);
                }
            }
        }
        catch
        {
            // Malformed .slnx → caller falls back to directory scan.
        }
        return result;
    }

    private static async Task<IReadOnlyList<Project>> OpenProjectsAsync(
        MSBuildWorkspace workspace, IReadOnlyList<string> csprojPaths)
    {
        var projects = new List<Project>();
        foreach (var csproj in csprojPaths)
        {
            try
            {
                projects.Add(await workspace.OpenProjectAsync(csproj));
            }
            catch (Exception ex)
            {
                StderrLog.Warn($"skip {csproj}: {ex.Message.Split('\n')[0]}");
            }
        }
        return projects;
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

    private static (InputKind Kind, string Path)? ResolveInput(
        string inputPath, List<ParseError> diagnostics, string repoRoot)
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
        // single .csproj would miss. Candidates are sorted Ordinal so the choice
        // is deterministic regardless of filesystem enumeration order.
        var solutions = EnumerateSource(inputPath, "*.sln")
            .Concat(EnumerateSource(inputPath, "*.slnx"))
            .ToList();
        solutions.Sort(StringComparer.Ordinal);
        if (solutions.Count > 0)
        {
            if (solutions.Count > 1)
                WarnMultiple(diagnostics, repoRoot, "solution", solutions);
            return (InputKind.Solution, Path.GetFullPath(solutions[0]));
        }

        var projects = EnumerateSource(inputPath, "*.csproj").ToList();
        projects.Sort(StringComparer.Ordinal);
        if (projects.Count == 0)
        {
            StderrLog.Error($"No .csproj or .sln files found under: {inputPath}");
            return null;
        }
        if (projects.Count > 1)
            WarnMultiple(diagnostics, repoRoot, "project (.csproj)", projects);
        return (InputKind.Project, Path.GetFullPath(projects[0]));
    }

    // Emits both a stderr note and a structured W007 diagnostic recording that
    // several candidates were found and which one was chosen deterministically.
    private static void WarnMultiple(
        List<ParseError> diagnostics, string repoRoot, string kind, IReadOnlyList<string> sorted)
    {
        var chosen = NormalizePath(sorted[0], repoRoot);
        StderrLog.Warn($"Multiple {kind} files found ({sorted.Count}); selected deterministically: {sorted[0]}");
        diagnostics.Add(new ParseError
        {
            File = chosen,
            Line = 0,
            Message = $"Multiple {kind} files found ({sorted.Count}); selected deterministically (Ordinal-first): {chosen}",
            Severity = "warning",
            Code = DiagnosticCodes.MultipleProjects,
        });
    }

    private static IEnumerable<string> EnumerateSource(string dir, string pattern) =>
        Directory.EnumerateFiles(dir, pattern, SearchOption.AllDirectories)
            .Where(p => !p.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                        && !p.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"));
}
