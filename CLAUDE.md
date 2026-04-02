# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AutoDocAPI is a GitHub App that automatically generates OpenAPI 3.0.3 documentation from source code after every successful deploy. It listens for GitHub `workflow_run` webhooks, clones the repo, parses routes via AST analysis (no AI/LLM), and opens a PR with the generated spec. Documentation is written in Turkish in `docs/`.

**Core principle:** Pure AST parsing only — no AI, no guessing. If a route isn't in the code, it doesn't appear in the spec.

## Commands

```bash
# Development
npm run dev              # Run with ts-node (src/app.ts)
npm run build            # TypeScript compile to dist/
npm start                # Run compiled dist/app.js

# Testing
npm test                 # Run all Jest tests
npm test -- --testPathPattern=expressParser   # Run a single test file
npm run test:coverage    # Jest with coverage

# Database (Drizzle ORM + PostgreSQL)
npm run migrate:generate # Generate migration from schema changes
npm run migrate:push     # Push schema to database

# .NET Analyzer (requires .NET 8 SDK)
cd analyzer && dotnet publish -c Release   # Build the C# analyzer
dotnet analyzer/bin/Release/net8.0/AutoDocAnalyzer.dll <repo-path>  # Run standalone

# Manual parser testing
npx ts-node scripts/test-parser.ts <repo-path> [express|nestjs|dotnet]
```

## Architecture

### Pipeline Flow

```
GitHub webhook (workflow_run.completed.success)
  → POST /webhook/github (signature verification + rate limiting)
  → AnalysisQueue (in-memory, concurrency-limited, per-repo debounce)
  → processAnalysis pipeline:
      1. Get installation token (cached in DB, auto-refresh)
      2. Check repo permissions (push access, not archived)
      3. Clone repo (depth=1, to OS temp dir)
      4. Remove sensitive files (.env, .pem, .key, credentials)
      5. Detect framework (config override → package.json → .csproj)
      6. Parse routes via framework-specific parser
      7. Generate OpenAPI 3.0.3 YAML
      8. Create PR via GitHub API (branch + commit + PR)
      9. Cleanup cloned repo
```

### Supported Frameworks and Their Parsers

| Framework | Parser | AST Tool | Integration |
|---|---|---|---|
| Express (JS/TS) | `src/parser/expressParser.ts` | Babel (`@babel/parser` + `@babel/traverse`) | In-process |
| NestJS | `src/parser/nestParser.ts` | ts-morph (Roslyn-like type-aware analysis) | In-process |
| ASP.NET Core | `src/parser/dotnetBridge.ts` → `analyzer/` | Roslyn (MSBuildWorkspace) | Child process — .NET CLI tool outputs JSON to stdout |

### Key Design Decisions

- **Express parser** uses Babel AST and does two traversal passes: first pass identifies router/app variables and global middleware; second pass extracts routes with params, body, query, auth, and TypeScript type information from `Request<Params, ResBody, ReqBody, ReqQuery>` generics.
- **NestJS parser** uses ts-morph for decorator-based route extraction (`@Controller`, `@Get`, `@Post`, `@Body`, `@Param`, `@Query`, `@UseGuards`). Resolves types including through `Promise<T>` unwrapping.
- **.NET analyzer** is a separate C# project (`analyzer/`) that uses Roslyn's MSBuildWorkspace for full semantic analysis. Falls back to syntax-only parsing if `dotnet restore` fails. Communicates with Node via JSON on stdout.
- **Queue** is in-memory (not Redis/external). Debounces per-repo — if a new webhook arrives for the same repo while one is queued, the older one is replaced.
- **Rate limiter** is an in-memory sliding window (1 hour) per repository.
- **Repo config override**: users can place `.autodoc.yml` in their repo root to force framework detection or customize output path (`docs_output`).

### Source Layout

- `src/api/` — Express routes: health check + GitHub webhook handler
- `src/pipeline/` — Orchestration: queue processing and the full analysis pipeline
- `src/parser/` — Framework-specific AST parsers + shared `types.ts`
- `src/detector/` — Framework auto-detection logic
- `src/generator/` — OpenAPI 3.0.3 YAML generator from `ParseResult`
- `src/github/` — GitHub App auth (JWT + installation tokens), repo cloning/cleanup, PR creation
- `src/db/` — Drizzle ORM schema (installations, repos, analyses, webhook_events) and connection
- `src/queue/` — In-memory concurrency-limited analysis queue
- `analyzer/` — Standalone .NET 8 CLI tool for ASP.NET route parsing via Roslyn

### Shared Types

All parsers produce `ParseResult` (defined in `src/parser/types.ts`) containing `RouteInfo[]` and `ParseError[]`. The `RouteInfo` shape is the contract between parsers and the OpenAPI generator.

## Environment

Requires Node.js 20, PostgreSQL, and .NET 8 SDK (for ASP.NET analysis). Copy `.env.example` to `.env` for local development. The GitHub App needs a PEM private key file. Deployed to VPS via SSH (`pm2 restart autodocapi`).

## Testing

Tests are in `test/` mirroring `src/` structure. The Express parser exposes `parseExpressSource()` for in-memory testing without filesystem. Tests use `ts-jest` preset. No database or network mocking required for parser/generator tests.
