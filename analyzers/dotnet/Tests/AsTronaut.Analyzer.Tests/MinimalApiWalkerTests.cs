using AsTronaut.Analyzer.Diagnostics;
using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Minimal API discovery + Workstream B diagnostics: skipped/degraded endpoints
// must surface a structured ParseError instead of vanishing silently.
public class MinimalApiWalkerTests
{
    [Fact]
    public void DiscoversLiteralRoute_WithNoDiagnostics()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;

            var app = WebApplication.Create();
            app.MapGet("/health", () => "ok");
            app.Run();
            """);

        Assert.Contains(result.Routes, r => r.Method == "GET" && r.Path == "/health");
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void NonLiteralRoutePath_EmitsW001_AndSkipsRoute()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;

            var app = WebApplication.Create();
            var dynamicPath = "/dynamic";
            app.MapGet(dynamicPath, () => "x");
            app.MapGet("/static", () => "y");
            app.Run();
            """);

        // The literal route still comes through.
        Assert.Contains(result.Routes, r => r.Path == "/static");
        Assert.DoesNotContain(result.Routes, r => r.Path == "/dynamic");

        // ...and the skipped one is reported, not silently dropped.
        var warning = Assert.Single(result.Errors);
        Assert.Equal(DiagnosticCodes.DynamicRoutePath, warning.Code);
        Assert.Equal("warning", warning.Severity);
        Assert.Equal(TestCompilation.SourcePath, warning.File);
        Assert.True(warning.Line > 0);
    }

    [Fact]
    public void MapGroupPrefix_IsCombinedIntoPath()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Routing;

            var app = WebApplication.Create();
            var group = app.MapGroup("/api");
            group.MapGet("/items", () => "list");
            app.Run();
            """);

        Assert.Contains(result.Routes, r => r.Method == "GET" && r.Path == "/api/items");
        Assert.Empty(result.Errors);
    }
}
