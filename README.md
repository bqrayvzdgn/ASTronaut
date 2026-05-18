# ASTronaut v2

OpenAPI 3.1 specs from your source code — pure AST, no AI.

CLI-first.

## Status

✅ **MVP ready (.NET).** Analyzes ASP.NET Core projects (both Controllers and full Minimal API surface) and emits valid OpenAPI 3.1.

### Supported today

- Controllers: `[ApiController]`, `[Route]`, `[HttpGet/Post/Put/Delete/Patch]`, route templates with constraints (`{id:int:min(1)}`, `{slug:alpha:length(3,40)}`, `{uuid:guid}`), `[FromBody/Query/Route/Header]`, return type → response schema.
- Minimal API: `MapGet/Post/Put/Delete/Patch`, nested `MapGroup`, fluent chain (`WithName`, `WithTags`, `WithSummary`, `WithDescription`, `RequireAuthorization`, `AllowAnonymous`), inline lambda + method-reference handlers.
- Data annotations → `Constraints` (`[Required]`, `[StringLength]`, `[MinLength]`, `[MaxLength]`, `[Range]`, `[RegularExpression]`, `[EmailAddress]`, `[Url]`, `[Phone]`, `[DataType]`).
- `[Authorize]` / `[AllowAnonymous]` → `securitySchemes` (bearer JWT by default).
- `[ProducesResponseType]` / `[ProducesResponseType<T>]` → multiple responses with schemas.
- XML doc comments (`<summary>`, `<remarks>`, `<param>`) → `summary` / `description` / parameter descriptions.
- DTO deduplication → `components/schemas` with `$ref`.

## Quick Start (target)

```bash
npx @astronaut/cli analyze ./my-aspnet-app
```

## Supported Frameworks

| Language | Framework                                | Parser              | Status  |
| -------- | ---------------------------------------- | ------------------- | ------- |
| C#       | ASP.NET Core (Controllers + Minimal API) | Roslyn (subprocess) | **MVP** |

## Development

Requires Node 20+, pnpm 10+, .NET 8+.

```bash
pnpm install
pnpm build:analyzers          # builds the .NET analyzer (bash; use scripts/build-analyzers.ps1 on pure Windows)
pnpm build                    # builds TS packages + CLI
pnpm test                     # vitest unit + snapshot suite

# Try it out against a checked-in fixture:
node apps/cli/dist/bin.js analyze fixtures/dotnet/controllers-rich -o out.yaml
```

## Architecture

See the per-package READMEs.
