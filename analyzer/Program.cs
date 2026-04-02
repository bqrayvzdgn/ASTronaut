using System.Diagnostics;
using System.Text.Json;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using AutoDocAnalyzer.Models;
using AutoDocAnalyzer.Parsers;

namespace AutoDocAnalyzer;

public static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> Main(string[] args)
    {
        if (args.Length < 1)
        {
            Console.Error.WriteLine("Usage: dotnet AutoDocAnalyzer.dll <repo-path>");
            return 1;
        }

        var repoPath = Path.GetFullPath(args[0]);
        if (!Directory.Exists(repoPath))
        {
            Console.Error.WriteLine($"Directory not found: {repoPath}");
            return 1;
        }

        var result = new ParseResult();

        try
        {
            // Find .csproj files
            var csprojFiles = FindCsprojFiles(repoPath);
            if (csprojFiles.Length == 0)
            {
                result.Errors.Add(new ParseError
                {
                    File = repoPath,
                    Reason = "No .csproj files found in repository",
                });
                OutputResult(result);
                return 0;
            }

            // Try MSBuild workspace first (requires dotnet restore)
            var restoreSucceeded = await TryDotnetRestore(repoPath, result);

            if (restoreSucceeded)
            {
                await ParseWithMSBuildWorkspace(csprojFiles, result);
            }
            else
            {
                result.Errors.Add(new ParseError
                {
                    File = repoPath,
                    Reason = "NuGet restore failed \u2014 type resolution limited",
                });
                ParseWithAdhocWorkspace(csprojFiles, repoPath, result);
            }
        }
        catch (Exception ex)
        {
            result.Errors.Add(new ParseError
            {
                File = repoPath,
                Reason = $"Unexpected error: {ex.Message}",
            });
        }

        OutputResult(result);
        return 0;
    }

    private static string[] FindCsprojFiles(string repoPath)
    {
        return Directory.GetFiles(repoPath, "*.csproj", SearchOption.AllDirectories)
            .Where(f => !f.Contains("node_modules") && !f.Contains(".git"))
            .ToArray();
    }

    private static async Task<bool> TryDotnetRestore(string repoPath, ParseResult result)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "dotnet",
                Arguments = "restore",
                WorkingDirectory = repoPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var process = Process.Start(psi);
            if (process == null)
                return false;

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));

            try
            {
                await process.WaitForExitAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                Console.Error.WriteLine("dotnet restore timed out after 60 seconds");
                return false;
            }

            if (process.ExitCode != 0)
            {
                var stderr = await process.StandardError.ReadToEndAsync();
                Console.Error.WriteLine($"dotnet restore failed: {stderr}");
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"dotnet restore error: {ex.Message}");
            return false;
        }
    }

    private static async Task ParseWithMSBuildWorkspace(string[] csprojFiles, ParseResult result)
    {
        // Register MSBuild before creating workspace
        if (!MSBuildLocator.IsRegistered)
        {
            var instances = MSBuildLocator.QueryVisualStudioInstances().ToArray();
            if (instances.Length == 0)
            {
                result.Errors.Add(new ParseError
                {
                    File = "MSBuild",
                    Reason = "No MSBuild instances found. Falling back to syntax-only parsing.",
                });
                ParseCsprojFilesWithoutSemantics(csprojFiles, result);
                return;
            }
            MSBuildLocator.RegisterInstance(instances.OrderByDescending(i => i.Version).First());
        }

        using var workspace = MSBuildWorkspace.Create();

        workspace.WorkspaceFailed += (sender, e) =>
        {
            if (e.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure)
            {
                Console.Error.WriteLine($"Workspace warning: {e.Diagnostic.Message}");
            }
        };

        foreach (var csprojPath in csprojFiles)
        {
            try
            {
                var project = await workspace.OpenProjectAsync(csprojPath);
                var compilation = await project.GetCompilationAsync();

                if (compilation == null)
                {
                    result.Errors.Add(new ParseError
                    {
                        File = csprojPath,
                        Reason = "Failed to compile project",
                    });
                    continue;
                }

                foreach (var syntaxTree in compilation.SyntaxTrees)
                {
                    var filePath = syntaxTree.FilePath;
                    if (string.IsNullOrEmpty(filePath))
                        continue;

                    // Skip generated and non-user code
                    if (filePath.Contains("obj/") || filePath.Contains("obj\\") ||
                        filePath.Contains("bin/") || filePath.Contains("bin\\"))
                        continue;

                    var semanticModel = compilation.GetSemanticModel(syntaxTree);

                    try
                    {
                        var controllerParser = new ControllerParser(semanticModel);
                        var controllerRoutes = controllerParser.Parse(syntaxTree, GetRelativePath(filePath, csprojPath));
                        result.Routes.AddRange(controllerRoutes);
                    }
                    catch (Exception ex)
                    {
                        result.Errors.Add(new ParseError
                        {
                            File = filePath,
                            Reason = $"Controller parsing error: {ex.Message}",
                        });
                    }

                    try
                    {
                        var minimalApiParser = new MinimalApiParser(semanticModel);
                        var minimalRoutes = minimalApiParser.Parse(syntaxTree, GetRelativePath(filePath, csprojPath));
                        result.Routes.AddRange(minimalRoutes);
                    }
                    catch (Exception ex)
                    {
                        result.Errors.Add(new ParseError
                        {
                            File = filePath,
                            Reason = $"Minimal API parsing error: {ex.Message}",
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                result.Errors.Add(new ParseError
                {
                    File = csprojPath,
                    Reason = $"Failed to open project: {ex.Message}",
                });
            }
        }
    }

    private static void ParseWithAdhocWorkspace(string[] csprojFiles, string repoPath, ParseResult result)
    {
        ParseCsprojFilesWithoutSemantics(csprojFiles, result);
    }

    private static void ParseCsprojFilesWithoutSemantics(string[] csprojFiles, ParseResult result)
    {
        foreach (var csprojPath in csprojFiles)
        {
            var projectDir = Path.GetDirectoryName(csprojPath)!;
            var csFiles = Directory.GetFiles(projectDir, "*.cs", SearchOption.AllDirectories)
                .Where(f => !f.Contains("obj/") && !f.Contains("obj\\") &&
                            !f.Contains("bin/") && !f.Contains("bin\\"))
                .ToArray();

            foreach (var csFile in csFiles)
            {
                try
                {
                    var code = File.ReadAllText(csFile);
                    var tree = Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(
                        code,
                        path: csFile);

                    // Parse without semantic model (null)
                    var controllerParser = new ControllerParser(null);
                    var controllerRoutes = controllerParser.Parse(tree, GetRelativePath(csFile, csprojPath));
                    result.Routes.AddRange(controllerRoutes);

                    var minimalApiParser = new MinimalApiParser(null);
                    var minimalRoutes = minimalApiParser.Parse(tree, GetRelativePath(csFile, csprojPath));
                    result.Routes.AddRange(minimalRoutes);
                }
                catch (Exception ex)
                {
                    result.Errors.Add(new ParseError
                    {
                        File = csFile,
                        Reason = $"Syntax parsing error: {ex.Message}",
                    });
                }
            }
        }
    }

    private static string GetRelativePath(string filePath, string csprojPath)
    {
        var projectDir = Path.GetDirectoryName(csprojPath)!;
        try
        {
            return Path.GetRelativePath(projectDir, filePath).Replace('\\', '/');
        }
        catch
        {
            return filePath;
        }
    }

    private static void OutputResult(ParseResult result)
    {
        // Deduplicate routes by path + method
        result.Routes = result.Routes
            .GroupBy(r => $"{r.Method}:{r.Path}")
            .Select(g => g.First())
            .OrderBy(r => r.Path)
            .ThenBy(r => r.Method)
            .ToList();

        var json = JsonSerializer.Serialize(result, JsonOptions);
        Console.WriteLine(json);
    }
}
