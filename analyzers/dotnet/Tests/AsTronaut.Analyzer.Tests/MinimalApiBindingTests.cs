using AsTronaut.Analyzer.Tests.Support;

namespace AsTronaut.Analyzer.Tests;

// Regression: DI-injected handler parameters (interfaces, ILogger<T>) must be
// skipped, not treated as a JSON request body. Previously the minimal API walker
// only recognized 6 exact framework types, so any injected service became a
// phantom body — the most damaging minimal-API defect.
public class MinimalApiBindingTests
{
    [Fact]
    public void InterfaceService_IsSkipped_DtoBecomesBody()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapPost("/users", (IUserService svc, CreateUserDto dto) => Results.Ok());
            app.Run();

            public interface IUserService { }
            public class CreateUserDto { public string Name { get; set; } = ""; }
            """);

        var route = result.Route("POST", "/users");
        Assert.NotNull(route.RequestBody);
        Assert.Equal("CreateUserDto", route.RequestBody!.Schema.RefName);
        Assert.Null(route.QueryParams);
        Assert.Null(route.PathParams);
    }

    [Fact]
    public void GenericILogger_IsSkipped()
    {
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;
            using Microsoft.Extensions.Logging;

            var app = WebApplication.Create();
            app.MapPost("/log", (ILogger<Program> logger, Entry entry) => Results.Ok());
            app.Run();

            public class Entry { public string Message { get; set; } = ""; }
            """);

        var route = result.Route("POST", "/log");
        Assert.Equal("Entry", route.RequestBody!.Schema.RefName);
    }

    [Fact]
    public void IFormFileInterface_StaysAFormBody_NotSkipped()
    {
        // IFormFile is an interface but is request data, not a service.
        var result = TestCompilation.Walk("""
            using Microsoft.AspNetCore.Builder;
            using Microsoft.AspNetCore.Http;

            var app = WebApplication.Create();
            app.MapPost("/upload", (IFormFile file) => Results.Ok());
            app.Run();
            """);

        var route = result.Route("POST", "/upload");
        Assert.NotNull(route.RequestBody);
        Assert.Equal("multipart/form-data", route.RequestBody!.ContentType);
    }
}
