# ASTronaut v2

![CI](https://github.com/bqrayvzdgn/ASTronaut/actions/workflows/ci.yml/badge.svg)

OpenAPI 3.1 specs from your source code — pure AST, no AI, CLI-first.

ASTronaut reads an ASP.NET Core project statically (no build output, no running app) and emits an
OpenAPI 3.1 document describing its HTTP API.

## Contents

- [Status](#status)
- [Features](#features)
- [Known limitations](#known-limitations)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)

## Status

🚧 **MVP (.NET), not yet production-grade.** Analyzes ASP.NET Core Controller projects, across a
whole solution, and emits OpenAPI 3.1. The checked-in fixtures produce valid documents, but some
common patterns still yield wrong or invalid output without failing the run — read
[Known limitations](#known-limitations) before relying on the result.

| Language | Framework                  | Parser              | Status  |
| -------- | -------------------------- | ------------------- | ------- |
| C#       | ASP.NET Core (Controllers) | Roslyn (subprocess) | **MVP** |

## Features

**Routing**

- Controllers: `[ApiController]`, `[Route]`, `[HttpGet/Post/Put/Delete/Patch]`, route templates with
  constraints (`{id:int:min(1)}`, `{slug:alpha:length(3,40)}`, `{uuid:guid}`),
  `[FromBody/Query/Route/Header/Form]`.
- URL-segment API versioning: `[ApiVersion]` fans out to one route per version; `[MapToApiVersion]`
  pins an action to a subset.
- Multiple projects: analyzes a whole `.sln`/`.slnx` (every C# project, DTOs hoisted once) or a
  single `.csproj`.

**Requests & responses**

- Return type → response schema; `[ProducesResponseType]` / `[ProducesResponseType<T>]` → multiple
  responses.
- `[Consumes]` / `[Produces]` → multiple request/response content types.
- A single `IFormFile` → `multipart/form-data` with a binary schema.

**Schemas & DTOs**

- Deduplication → `components/schemas` with `$ref`; inheritance (derived schemas include inherited
  properties); records, record structs and generics.
- `Dictionary<K, V>` → `object` with `additionalProperties`.
- Enums per System.Text.Json: numeric by default, string+names when a `JsonStringEnumConverter`
  applies (globally or via `[JsonConverter]`).
- `[JsonPolymorphic]` / `[JsonDerivedType]` → `oneOf` + `discriminator` (with `$ref` mapping).
- Property names honor the global JSON naming policy, `[JsonPropertyName]`, Newtonsoft
  `[JsonProperty]`, and `[JsonIgnore]`.
- Data annotations → constraints (`[Required]`, `[StringLength]`, `[MinLength]`, `[MaxLength]`,
  `[Range]`, `[RegularExpression]`, `[EmailAddress]`, `[Url]`, `[Phone]`, `[DataType]`).

**Auth, docs & diagnostics**

- `[Authorize]` / `[AllowAnonymous]` → `securitySchemes` (bearer JWT by default; API key, OAuth2 and
  OpenID Connect by scheme name).
- XML doc comments (`<summary>`, `<remarks>`, `<param>`) → `summary` / `description` / parameter
  descriptions.
- Some skipped or degraded input is reported as structured diagnostics (`W003` workspace load,
  `W004` skipped open-generic controller, `W007` multiple candidate projects, `E001` load failure);
  `--strict` fails the run on error diagnostics. Not every skip is covered yet.

## Known limitations

**Wrong or invalid output, exit code 0**

- `[HttpGet]` + a separate action-level `[Route("{id}")]`: the action `[Route]` is ignored, so the
  operation lands on the controller path, its route parameters become query parameters, and another
  action on that path is dropped as a "duplicate".
- `[Authorize(Policy = "...")]` produces a security scheme named `bearerAuth:<policy>`, which is not
  a valid OpenAPI component name — the document fails the 3.1 meta-schema.
- Several `IFormFile` parameters on one action: only the last one survives in the request body;
  `[FromForm]` scalars are emitted as query parameters.
- `internal` controllers and `[NonController]` classes are emitted as if they were routable.
- Duplicate path + method pairs are reported only as a stderr line, not as a diagnostic, so
  `--strict` does not catch them; the CLI does not validate its own output against the meta-schema.

**Not supported**

- Minimal APIs (`app.MapGet` …) — removed from scope; only Controllers are analyzed.
- Conventional routing (`MapControllerRoute`), multiple/verb-less `[Route]`, `[area]`, `~/`
  overrides.
- Query/header/media-type API versioning; Swashbuckle/NSwag metadata attributes; `[Tags]`.
- Anything configured at runtime in `Program.cs` (auth schemes, policies, middleware) — the analyzer
  reads attributes and types only.

**Distribution**

- The packages are not published yet (`private: true`) and the CLI finds the analyzer relative to
  this repository, so `npx @astronaut/cli` does not work; run it from a checkout.

## Requirements

- Node.js 20+
- pnpm 10+
- .NET SDK 8+
- bash for the `pnpm build:analyzers` / `pnpm restore:fixtures` scripts (PowerShell equivalents live
  in `scripts/*.ps1`)

## Installation

```bash
git clone https://github.com/bqrayvzdgn/ASTronaut.git
cd ASTronaut
pnpm install
pnpm build:analyzers   # builds the .NET analyzer into analyzers/dotnet/dist
pnpm build             # builds the TS packages and the CLI
```

## Usage

```bash
# a directory, a .csproj, or a .sln/.slnx all work
node apps/cli/dist/bin.js analyze <path> [options]

# example against a checked-in fixture
node apps/cli/dist/bin.js analyze fixtures/dotnet/controllers-rich -o out.yaml
```

| Option                    | Effect                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `-o, --output <file>`     | write to a file (directories are created) instead of stdout |
| `--json`                  | emit JSON instead of YAML                                   |
| `--strict`                | exit 1 if the analyzer reports any error diagnostic         |
| `--title <title>`         | override `info.title` (default: from the `.csproj`/`.sln`)  |
| `--version-tag <version>` | override `info.version` (default: `<Version>` or `0.0.0`)   |

**Exit codes**

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| `0`  | document emitted                                                        |
| `1`  | no project found, analyzer failure, 0 routes, or `--strict` with errors |
| `2`  | analyzer binary not found, or a fatal CLI error                         |

Diagnostics and progress go to stderr; stdout carries only the document.

The analyzer is located via the `ASTRONAUT_DOTNET_ANALYZER` environment variable if set, otherwise
`analyzers/dotnet/dist/AsTronaut.Analyzer.dll` in the repository.

## Architecture

A language-agnostic intermediate representation (IR) sits between parsers and the generator, so new
languages can be added without touching the generator:

```
C# source ──▶ .NET analyzer (Roslyn) ──▶ ParseResult (IR, JSON) ──▶ generator ──▶ OpenAPI 3.1
```

| Path                     | Role                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proto/parser.proto`     | The IR contract and single source of truth. `packages/core` (`ir.ts` + zod `validate.ts`) and the analyzer's `IR.cs` mirror it; `drift.test.ts` guards them. |
| `analyzers/dotnet`       | Roslyn-based analyzer; emits one `ParseResult` JSON document on stdout.                                                                                       |
| `packages/parser-bridge` | Spawns the analyzer as a subprocess and validates its output.                                                                                                 |
| `packages/generator`     | Turns the IR into OpenAPI 3.1 YAML/JSON.                                                                                                                      |
| `apps/cli`               | The `astronaut` CLI that wires it together.                                                                                                                   |

## Development

| Command                 | What it does                                          |
| ----------------------- | ----------------------------------------------------- |
| `pnpm build:analyzers`  | build the .NET analyzer                               |
| `pnpm build`            | build the TS packages and the CLI                     |
| `pnpm test`             | vitest unit + snapshot suite (incl. the IR drift check) |
| `pnpm test:e2e`         | end-to-end suite over the fixture projects            |
| `pnpm lint` / `lint:fix`| Biome check                                           |
| `pnpm gen:proto`        | regenerate IR code from `proto/parser.proto`          |
| `pnpm clean`            | remove `dist`, `coverage` and `.tsbuildinfo`          |

CI (`.github/workflows/ci.yml`) runs lint, build, vitest and the .NET tests on every push and pull
request, and the end-to-end suite on both Ubuntu and Windows.

## Testing

```bash
pnpm test                                               # TS unit tests
dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests   # analyzer unit tests (in-memory Roslyn)

pnpm restore:fixtures   # once per checkout
pnpm test:e2e           # fixtures through the full pipeline + the CLI contract
```

### End-to-end suite

Each directory under `fixtures/dotnet/` is a real ASP.NET Core project (or `.sln`).
`apps/cli/test/pipeline.e2e.test.ts` runs every fixture through analyzer → IR → generator and
checks three gates:

1. **Golden** — byte-for-byte match with the committed `expected.openapi.yaml`.
2. **OpenAPI 3.1 meta-schema** validity.
3. **Invariants** the meta-schema cannot express, from `checkOpenApiInvariants`
   (`packages/generator/src/invariants.ts`):
   - every `operationId` is unique;
   - no duplicate `{in, name}` parameter within an operation;
   - every `$ref` resolves under `components/schemas`;
   - every `{param}` in a path template has a path parameter, and vice versa;
   - every `security` requirement names a defined scheme;
   - nullable is emitted 3.1-style (`type: [..., "null"]`);
   - no empty or `null` schema.

`apps/cli/test/cli.e2e.test.ts` runs the real `bin.js` against the same fixtures to pin the CLI
contract (exit codes, stdout/stderr, options).

| Fixture                    | Covers                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| `controllers-basic`        | CRUD routes, `[FromBody]`, return-type responses, simple DTOs                  |
| `controllers-rich`         | `[ProducesResponseType]`, data annotations, `[Authorize]`/`[AllowAnonymous]`, XML docs |
| `controllers-route-params` | route constraints, `[controller]` token, `[FromQuery]` defaults, `[FromHeader(Name)]` |
| `controllers-features`     | `[AsParameters]`, enums, polymorphism, naming policy, versioning, OAuth2/OIDC  |
| `solution-multi-project`   | `.sln` analysis, cross-project DTO dedup, deterministic project order          |
| `diagnostics-open-generic` | `W004`; `--strict` still passes on warnings                                    |
| `diagnostics-multi-csproj` | `W007` when several projects are candidates                                    |
| `diagnostics-load-failure` | `E001` → exit 1 (no golden; CLI test only)                                     |

### Adding a fixture

1. Create a `net8.0` project under `fixtures/dotnet/<kind>-<topic>/` (`Microsoft.NET.Sdk.Web`).
   **Do not add NuGet `PackageReference`s** — restore must stay offline; stub third-party
   attributes instead (see `controllers-features/Versioning`), since the analyzer matches attributes
   by short name.
2. Keep it to one topic; note at the top of each controller what it covers.
3. Use ASCII file and directory names with consistent casing, so the CLI (`localeCompare`) and the
   analyzer (`Ordinal`) pick the same candidate.
4. Check it compiles with `dotnet build <csproj>`, then run `pnpm restore:fixtures`.
5. Run `pnpm test:e2e` to write `expected.openapi.yaml`, then **read it**: check every path,
   parameter, schema and constraint. Unexpected output is an analyzer finding — report it, do not
   "fix" the golden.
6. A fixture that must not produce output goes into `FAILURE_FIXTURES` in `pipeline.e2e.test.ts`,
   with its contract in `cli.e2e.test.ts`.

### Updating goldens

After an intended change to analyzer or generator output:

```bash
pnpm test:e2e -u
git diff fixtures/   # review every line and justify the change in the PR
```

Vitest does not write new snapshots when `CI` is set, so goldens must be committed.

### Known findings frozen in goldens

Goldens record **current** behaviour. These lines are knowingly wrong and frozen until the analyzer
or generator is fixed; the fix will show up as a golden diff, and this table should be updated with
it.

| #  | Where                                                    | Finding                                                                                                                                                  |
| -- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 | `controllers-features` → `GET /api/products` parameters  | Query names flattened from `[AsParameters]` carry the global JSON naming policy (`page_size`), but MVC query binding matches the property name.          |
| F2 | same                                                     | Properties with an initializer (`Page = 1`) are emitted `required: true`; the "default ⇒ optional" rule for parameters is not applied to properties.     |
| F3 | `components.schemas.ProductQuery`                        | The flattened type is hoisted although nothing references it (orphan schema).                                                                            |
| F4 | `/api/v1.0/Reports` (`Reports_List`) vs `/api/v2.0/Reports` (`List_2`) | operationId dedup across a version fan-out produces inconsistent names (generator `uniqueOperationId`).                                    |
| F5 | `controllers-features` → `[AsParameters]`                | A Minimal-API attribute that MVC ignores; `[ApiController]` infers `[FromBody]` for the complex parameter, so the flatten behaviour needs revisiting.     |
