# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ASTronaut is a GitHub App that automatically generates OpenAPI 3.0.3 documentation from source code after every successful deploy. It listens for GitHub `workflow_run` webhooks, clones the repo, parses routes via AST analysis (no AI/LLM), and opens a PR with the generated spec. Documentation is written in Turkish in `docs/`.

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
dotnet analyzer/bin/Release/net8.0/ASTronautAnalyzer.dll <repo-path>  # Run standalone

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
| Next.js | `src/parser/nextParser.ts` | File-based routing + AST (app dir & pages dir) | In-process |
| ASP.NET Core | `src/parser/dotnetBridge.ts` → `analyzer/` | Roslyn (MSBuildWorkspace) | Child process — .NET CLI tool outputs JSON to stdout |

### Key Design Decisions

- **Express parser** uses Babel AST and does two traversal passes: first pass identifies router/app variables and global middleware; second pass extracts routes with params, body, query, auth, and TypeScript type information from `Request<Params, ResBody, ReqBody, ReqQuery>` generics.
- **NestJS parser** uses ts-morph for decorator-based route extraction (`@Controller`, `@Get`, `@Post`, `@Body`, `@Param`, `@Query`, `@UseGuards`). Resolves types including through `Promise<T>` unwrapping.
- **.NET analyzer** is a separate C# project (`analyzer/`) that uses Roslyn's MSBuildWorkspace for full semantic analysis. Falls back to syntax-only parsing if `dotnet restore` fails. Communicates with Node via JSON on stdout.
- **Queue** is in-memory (not Redis/external). Debounces per-repo — if a new webhook arrives for the same repo while one is queued, the older one is replaced.
- **Rate limiter** is an in-memory sliding window (1 hour) per repository.
- **Next.js parser** uses file-based routing analysis — scans both `app/` directory (`route.ts` files) and `pages/` directory, handles dynamic routes (`[id]`, `[...slug]`), and extracts API route handlers.
- **Repo config override**: users can place `.autodoc.yml` in their repo root to force framework detection or customize output path (`docs_output`).

### `.autodoc.yml` Schema

```yaml
framework: express | nestjs | aspnet | nextjs   # Override auto-detection
docs_output: docs/openapi.yaml                   # Custom output path (default: docs/openapi.yaml)
```

Path safety: `docs_output` rejects absolute paths, `..` traversal, backslashes, null bytes, and colons.

### Framework Detection Priority

1. `.autodoc.yml` `framework` field (if present and valid)
2. `package.json` dependencies: `@nestjs/core` → NestJS, `next` → Next.js, `express` → Express
3. `.csproj` with `Microsoft.AspNetCore` → ASP.NET (checks for Controllers vs Minimal API vs both)

### Configurable Timeouts

| Operation | Env Var | Default |
|---|---|---|
| Clone | `CLONE_TIMEOUT_MS` | 30s |
| .NET restore | `RESTORE_TIMEOUT_MS` | 60s |
| Parse | `PARSE_TIMEOUT_MS` | 60s |
| PR creation | `PR_TIMEOUT_MS` | 15s |

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

## Git Workflow

- **`main` is the deploy branch.** Pushes to `main` trigger CI (test → deploy to VPS).
- All changes must go through a feature branch: `git checkout -b feature/<name>` from `main`.
- Open a PR to `main` and verify the changes work before merging.
- Branch naming: `feature/`, `fix/`, `chore/` prefixes.
- Delete merged branches (both local and remote) after PR is merged.

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions).
- If something goes sideways, STOP and re-plan immediately — don't keep pushing.
- Use plan mode for verification steps, not just building.
- Write detailed specs upfront to reduce ambiguity.

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean.
- Offload research, exploration, and parallel analysis to subagents.
- For complex problems, throw more compute at it via subagents.
- One task per subagent for focused execution.

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern.
- Write rules for yourself that prevent the same mistake.
- Ruthlessly iterate on these lessons until mistake rate drops.
- Review lessons at session start for relevant project.

### 4. Verification Before Done
- Never mark a task complete without proving it works.
- Diff behavior between `prod` and your changes when relevant.
- Ask yourself: "Would a staff engineer approve this?"
- Run `npm test`, `npm run build`, check logs, demonstrate correctness.

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution."
- Skip this for simple, obvious fixes — don't over-engineer.
- Challenge your own work before presenting it.

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests — then resolve them.
- Zero context switching required from the user.
- Go fix failing CI tests without being told how.

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items.
2. **Verify Plan**: Check in before starting implementation.
3. **Track Progress**: Mark items complete as you go.
4. **Explain Changes**: High-level summary at each step.
5. **Document Results**: Add review section to `tasks/todo.md`.
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## API Endpoints

- `GET /health` — Checks DB connectivity and .NET SDK availability. Returns 200 or 503 with detailed status.
- `POST /webhook/github` — Receives `workflow_run` webhooks. Verifies HMAC-SHA256 signature via constant-time comparison.

## CI/CD

Push to `main` → GitHub Actions runs `npm test` → on success, SSH deploys to VPS (`git pull`, `npm ci --production`, `npm run build`, `dotnet publish`, `pm2 restart astronaut`). Workflow defined in `.github/workflows/deploy.yml`.

## Environment

Requires Node.js 20, PostgreSQL, and .NET 8 SDK (for ASP.NET analysis). Copy `.env.example` to `.env` for local development. The GitHub App needs a PEM private key file. Deployed to VPS via SSH (`pm2 restart astronaut`). Key env vars: `MAX_CONCURRENT_ANALYSES` (default 3), `RATE_LIMIT_PER_HOUR` (default 10), and timeout vars (see Configurable Timeouts above).

## Testing

Tests are in `test/` mirroring `src/` structure. The Express parser exposes `parseExpressSource()` for in-memory testing without filesystem. Tests use `ts-jest` preset. No database or network mocking required for parser/generator tests.
