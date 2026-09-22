namespace AsTronaut.Analyzer.Discovery;

// Sort key for file paths whose order must be identical on every OS. '\' (0x5C)
// sorts after the ASCII letters while '/' (0x2F) sorts before them, so a raw
// Ordinal sort places "Api\Zed.cs" and "ApiClient.cs" differently on Windows and
// Linux. Normalising to '/' makes the order the same everywhere.
public static class PathOrder
{
    public static string Key(string? path) => (path ?? "").Replace('\\', '/');
}
