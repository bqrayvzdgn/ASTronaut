# ASTronaut v2

OpenAPI 3.1 specs from your source code — pure AST, no AI.

CLI-first. Webhook flow planned for V2.

## Status

🚧 **Active rewrite (M0 bootstrap).** Not usable yet. See [`docs/adr/`](./docs/adr/) for design decisions.

## Quick Start (target)

```bash
npx @astronaut/cli analyze ./my-app
```

## Supported Frameworks (planned for v0.1.0)

| Language        | Framework                                  | Parser              |
| --------------- | ------------------------------------------ | ------------------- |
| JS / TS         | Express                                    | Babel + ts-morph    |
| Go              | Gin                                        | Go AST (subprocess) |
| C#              | ASP.NET Core (Controllers + Minimal API)   | Roslyn (subprocess) |

## Development

Requires Node 20+, pnpm 10+, Go 1.21+, .NET 8+.

```bash
pnpm install
pnpm gen:proto
pnpm build:analyzers
pnpm build
pnpm test
```

## Architecture

See [`docs/adr/`](./docs/adr/) and the per-package READMEs.
