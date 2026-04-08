# ASTronaut

A GitHub App that automatically generates [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3) documentation from your source code after every successful deploy — powered by pure AST analysis, no AI.

## How It Works

```
Deploy succeeds → GitHub fires webhook → ASTronaut clones repo
  → Detects framework → Parses routes via AST → Generates OpenAPI spec
  → Opens a PR with the updated docs
```

1. Install the GitHub App on your repositories
2. Push to `main` and your CI/CD pipeline succeeds
3. ASTronaut receives a `workflow_run` webhook, clones your repo, and analyzes the source code
4. A pull request is opened with an up-to-date `docs/openapi.yaml`

Your source code is **deleted from the server immediately** after analysis.

## Supported Frameworks

| Language | Framework | Parser |
|---|---|---|
| JavaScript / TypeScript | **Express** | Babel (`@babel/parser` + `@babel/traverse`) |
| C# | **ASP.NET Core** (Controllers + Minimal API) | Roslyn (`MSBuildWorkspace`) |
| Go | **Gin** | Go AST (`go/parser` + `go/ast`) |

### What Gets Detected

- Routes, HTTP methods, and path prefixes
- Path, query, and header parameters (with types from TypeScript generics and decorators)
- Request body schemas
- Response types
- Auth middleware / guards (`passport.authenticate`, Gin middleware, etc.)
- JSDoc / XML doc / Go comments descriptions

## Configuration

ASTronaut works with **zero configuration**. Optionally, add a `.autodoc.yml` to your repo root:

```yaml
# Force framework detection (useful for monorepos)
framework: express  # express | aspnet | gin (or any registry-supported framework)

# Custom output path for the generated spec (default: docs/openapi.yaml)
docs_output: api/openapi.yaml
```

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Backend | Express 4.x + TypeScript 5.x |
| AST (JS/TS) | Babel |
| AST (C#) | Roslyn (.NET 8 CLI tool) |
| AST (Go) | Go standard library (`go/parser` + `go/ast`) |
| Database | PostgreSQL 16 + Drizzle ORM |
| GitHub API | Octokit (`@octokit/rest`) |
| Logging | Pino |
| Testing | Jest + ts-jest |
| CI/CD | GitHub Actions |

## Development Setup

### Prerequisites

- Node.js 20+
- PostgreSQL
- .NET 8 SDK (for ASP.NET analysis)
- Go 1.21+ (for Gin analysis)

### Getting Started

```bash
# Install dependencies
npm install

# Build the .NET analyzer
cd analyzer && dotnet publish -c Release && cd ..

# Copy environment config
cp .env.example .env
# Edit .env with your database URL and GitHub App credentials

# Push database schema
npm run migrate:push

# Start development server
npm run dev
```

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the `.pem` private key |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret for signature verification |
| `DOTNET_ANALYZER_PATH` | Path to the compiled .NET analyzer DLL |
| `MAX_CONCURRENT_ANALYSES` | Max parallel analyses (default: 3) |
| `RATE_LIMIT_PER_HOUR` | Webhook rate limit per repo (default: 10) |

### Commands

```bash
npm run dev              # Run dev server (ts-node)
npm run build            # Compile TypeScript
npm start                # Run production build
npm test                 # Run tests
npm run test:coverage    # Tests with coverage report
npm run migrate:generate # Generate DB migration
npm run migrate:push     # Apply schema to DB
```

### Testing a Parser Locally

```bash
npx ts-node scripts/test-parser.ts /path/to/repo [express|aspnet|gin]
```

## Branch Strategy

| Branch | Purpose |
|---|---|
| `prod` | Production (default branch) |
| `dev` | Active development |

## License

Private — All rights reserved.
