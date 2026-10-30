namespace AsTronaut.Analyzer.Discovery;

public static class PathOrder
{
    public static string Key(string? path) => (path ?? "").Replace('\\', '/');
}
