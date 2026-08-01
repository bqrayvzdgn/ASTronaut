# ASTronaut v2

OpenAPI 3.1 specs from your source code — pure AST, no AI.

CLI-first.

![CI](https://github.com/bqrayvzdgn/ASTronaut/actions/workflows/ci.yml/badge.svg)

## Status

✅ **MVP ready (.NET).** Analyzes ASP.NET Core Controller projects, across a whole solution, and emits valid OpenAPI 3.1.

### Supported today

**Routing**

- Controllers: `[ApiController]`, `[Route]`, `[HttpGet/Post/Put/Delete/Patch]`, route templates with constraints (`{id:int:min(1)}`, `{slug:alpha:length(3,40)}`, `{uuid:guid}`), `[FromBody/Query/Route/Header/Form]`.
- Multiple projects: analyzes a whole `.sln`/`.slnx` (every C# project, DTOs hoisted once) or a single `.csproj`.

**Requests & responses**

- Return type → response schema; `[ProducesResponseType]` / `[ProducesResponseType<T>]` → multiple responses.
- `[Consumes]` / `[Produces]` → multiple request/response content types.
- `IFormFile` / `[FromForm]` → `multipart/form-data` with binary schema.

**Schemas & DTOs**

- Deduplication → `components/schemas` with `$ref`; inheritance (derived schemas include inherited properties); records and generics.
- `Dictionary<K, V>` → `object` with `additionalProperties`.
- Enums per System.Text.Json: numeric by default, string+names when a `JsonStringEnumConverter` applies (globally or via `[JsonConverter]`).
- `[JsonPolymorphic]` / `[JsonDerivedType]` → `oneOf` + `discriminator` (with `$ref` mapping).
- Property names honor `[JsonPropertyName]`, Newtonsoft `[JsonProperty]`, and `[JsonIgnore]`.
- Data annotations → `Constraints` (`[Required]`, `[StringLength]`, `[MinLength]`, `[MaxLength]`, `[Range]`, `[RegularExpression]`, `[EmailAddress]`, `[Url]`, `[Phone]`, `[DataType]`).

**Auth, docs & diagnostics**

- `[Authorize]` / `[AllowAnonymous]` → `securitySchemes` (bearer JWT by default).
- XML doc comments (`<summary>`, `<remarks>`, `<param>`) → `summary` / `description` / parameter descriptions.
- Endpoints or projects the analyzer can't fully parse are reported as structured warnings (e.g. `W003`, `W007`) instead of being dropped silently; `--strict` fails the run on errors.

## Quick Start (target)

```bash
# a directory, a .csproj, or a .sln/.slnx all work
npx @astronaut/cli analyze ./my-aspnet-app
```

## Supported Frameworks

| Language | Framework                                | Parser              | Status  |
| -------- | ---------------------------------------- | ------------------- | ------- |
| C#       | ASP.NET Core (Controllers)               | Roslyn (subprocess) | **MVP** |

## Development

Requires Node 20+, pnpm 10+, .NET 8+.

```bash
pnpm install
pnpm build:analyzers          # builds the .NET analyzer (bash; use scripts/build-analyzers.ps1 on pure Windows)
pnpm build                    # builds TS packages + CLI
pnpm test                     # vitest unit + snapshot suite (incl. the IR drift-check)

# .NET analyzer unit tests (in-memory Roslyn, no MSBuild):
dotnet test analyzers/dotnet/Tests/AsTronaut.Analyzer.Tests

# Try it out against a checked-in fixture:
node apps/cli/dist/bin.js analyze fixtures/dotnet/controllers-rich -o out.yaml
```

CI (`.github/workflows/ci.yml`) runs lint + build + vitest and the .NET tests on every push and pull request.

## Architecture

A language-agnostic intermediate representation (IR) sits between parsers and the
generator, so new languages can be added without touching the generator:

```
C# source ──▶ .NET analyzer (Roslyn) ──▶ ParseResult (IR, JSON) ──▶ generator ──▶ OpenAPI 3.1
```

- **`proto/parser.proto`** — the IR contract and single source of truth. `packages/core` (`ir.ts` + zod `validate.ts`) and the analyzer's `IR.cs` mirror it; `packages/core/test/drift.test.ts` guards them against drift.
- **`analyzers/dotnet`** — the Roslyn-based analyzer; emits one `ParseResult` JSON document on stdout.
- **`packages/parser-bridge`** — spawns the analyzer as a subprocess and validates its output.
- **`packages/generator`** — turns the IR into OpenAPI 3.1 YAML/JSON.
- **`apps/cli`** — the `astronaut` CLI that wires it together.
