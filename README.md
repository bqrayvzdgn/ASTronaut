# ASTronaut

ASTronaut generates an OpenAPI 3.1 spec from ASP.NET Core **controller-based** projects by statically analyzing the source with Roslyn. It never builds-and-runs your app, so no database, secrets or running server are needed.

**Out of scope:** Minimal APIs (`app.MapGet(...)` and friends). Only controllers are analyzed.

## Prerequisites

- Node.js 20 or newer
- [pnpm](https://pnpm.io) 10 (the repo pins `pnpm@10.33.0`)
- .NET 8 SDK (builds and runs the Roslyn-based analyzer)

## Install

```sh
pnpm install
pnpm build              # TypeScript packages and CLI
pnpm build:analyzers    # publishes the .NET analyzer to analyzers/dotnet/dist
```

The CLI looks for the analyzer at `analyzers/dotnet/dist/AsTronaut.Analyzer.dll`. Set `ASTRONAUT_DOTNET_ANALYZER` to point at a different build.

## Usage

```sh
pnpm cli analyze <path> [options]
```

`<path>` is a directory containing a `.sln`/`.slnx` or `.csproj`, or one of those files directly. If several are found, a solution is preferred and the first match (alphabetically) is used, with a warning.

| Option | Description |
| --- | --- |
| `-o, --output <file>` | Write to a file instead of stdout |
| `--json` | Emit JSON instead of YAML |
| `--strict` | Exit non-zero if the analyzer reports any error diagnostic |
| `--title <title>` | Override the spec `info.title` |
| `--version-tag <version>` | Override the spec `info.version` |

Examples:

```sh
# YAML to stdout
pnpm cli analyze ../MyApi

# JSON to a file, failing on analyzer errors
pnpm cli analyze ../MyApi/MyApi.csproj --json --strict -o out/openapi.json
```

Diagnostics and progress go to stderr, so piping stdout stays clean. Exit codes: `0` success, `1` nothing to emit or a failure (no project found, 0 routes, `--strict` errors), `2` analyzer not found.

## Layout

| Path | Role |
| --- | --- |
| `apps/cli` | `astronaut` command (commander) |
| `packages/parser-bridge` | Spawns the .NET analyzer and reads its output |
| `packages/core` | IR types generated from `proto/parser.proto` |
| `packages/generator` | IR to OpenAPI 3.1 (YAML/JSON) |
| `analyzers/dotnet` | Roslyn analyzer (net8.0) |
