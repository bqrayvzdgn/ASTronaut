namespace AsTronaut.Analyzer.Logging;

// All diagnostic output goes through here. stdout is reserved exclusively for
// the single ParseResult JSON document — any log line on stdout will break the
// parser-bridge JSON.parse downstream.
public static class StderrLog
{
    public static void Info(string message) => Console.Error.WriteLine($"[info] {message}");
    public static void Warn(string message) => Console.Error.WriteLine($"[warn] {message}");
    public static void Error(string message) => Console.Error.WriteLine($"[error] {message}");
}
