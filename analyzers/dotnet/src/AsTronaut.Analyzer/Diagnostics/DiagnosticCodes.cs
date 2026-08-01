namespace AsTronaut.Analyzer.Diagnostics;

// Stable diagnostic codes for ParseError.Code. Kept greppable so consumers can
// suppress/track specific classes of partial-parse in CI. "W" = warning
// (something was skipped or degraded but the run still produced output);
// "E" = error (the run failed to produce meaningful output; `--strict` fails).
public static class DiagnosticCodes
{
    // W001 (DynamicRoutePath) and W002 (UnresolvedHandler) were emitted only by the
    // minimal-API walker and W006 (DuplicateRoute) only by the controller/minimal
    // route merge; all three were retired when Minimal API support was removed. The
    // codes are left unassigned rather than reused so historical logs stay unambiguous.

    // MSBuild reported a workspace load failure; the compilation may be partial.
    public const string WorkspaceLoad = "W003";

    // An MVC controller was skipped (abstract or otherwise unresolvable). Reserved
    // for emission by the controller walker in a separate workstream.
    public const string SkippedController = "W004";

    // An MVC action's result body could not be resolved to a concrete type.
    // Reserved for emission by the controller walker in a separate workstream.
    public const string UnresolvedResult = "W005";

    // Multiple candidate projects/solutions were found in a directory scan; one
    // was selected deterministically (Ordinal-first).
    public const string MultipleProjects = "W007";

    // A project/solution could not be loaded, or produced no compilation at all;
    // the run yields no analyzable surface. Surfaced as an error so `--strict`
    // consumers fail the build.
    public const string ProjectLoadFailed = "E001";
}
