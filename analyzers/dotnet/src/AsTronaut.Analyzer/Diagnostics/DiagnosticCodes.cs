namespace AsTronaut.Analyzer.Diagnostics;

// Stable diagnostic codes for ParseError.Code. Kept greppable so consumers can
// suppress/track specific classes of partial-parse in CI. "W" = warning
// (something was skipped or degraded but the run still produced output).
public static class DiagnosticCodes
{
    // A Map* endpoint whose route path is not a string literal was skipped.
    public const string DynamicRoutePath = "W001";

    // A method-reference handler could not be resolved to a symbol; the route is
    // still emitted but its parameters/responses may be incomplete.
    public const string UnresolvedHandler = "W002";

    // MSBuild reported a workspace load failure; the compilation may be partial.
    public const string WorkspaceLoad = "W003";
}
