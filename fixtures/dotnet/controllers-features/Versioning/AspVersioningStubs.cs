// Stand-ins for the Asp.Versioning.Mvc attributes so the fixture restores with
// no NuGet dependency. The analyzer matches attributes by short name (see
// AttributeReader), exactly as the in-memory analyzer tests do, so these stubs
// exercise the same code path as the real package.
namespace Asp.Versioning;

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public sealed class ApiVersionAttribute : Attribute
{
    public ApiVersionAttribute(string version) => Version = version;

    public string Version { get; }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class MapToApiVersionAttribute : Attribute
{
    public MapToApiVersionAttribute(string version) => Version = version;

    public string Version { get; }
}
