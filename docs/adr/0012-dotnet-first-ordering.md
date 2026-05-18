# ADR-0012: .NET-first MVP ordering

**Status:** Accepted
**Date:** 2026-05-18

## Context

The original framework matrix in `README.md` and the implicit order in [ADR-0003](./0003-cli-first.md)'s consequence section put Express (JS/TS) first, then Gin (Go), then ASP.NET Core (.NET). That ordering was a wishlist, not a commitment. After M0 shipped (core IR + zod validators), the user explicitly redirected scope: a single end-to-end MVP targeting **ASP.NET Core only**, with Controllers and the full Minimal API surface. JS and Go remain on the roadmap; they are not on the critical path to demo.

## Decision

Implement the full pipeline (`@astronaut/generator` → `analyzers/dotnet` → `@astronaut/parser-bridge` → `@astronaut/cli`) end-to-end for .NET before authoring any JS or Go parser. The IR, generator, bridge, and CLI are framework-agnostic by construction; only the analyzer is .NET-specific. New parsers slot in later by adding a new entry to a parser registry behind the same IR contract.

Iteration order (per the active MVP plan):

| Iter | Component | Demo? |
|---|---|---|
| A | `@astronaut/generator` (IR → OpenAPI 3.1 YAML/JSON) | no |
| B | `analyzers/dotnet` — Controllers | no |
| C | `analyzers/dotnet` — full Minimal API | no |
| D | `@astronaut/parser-bridge` + `@astronaut/cli` | **yes** |
| E | Rich features (annotations, auth, DTO dedup, XML doc) | refined demo |
| F | Polish (error UX, `--strict`, real-project regression) | refined demo |

## Consequences

- ✅ The IR is validated against the hardest analyzer (Roslyn + MSBuildWorkspace) first. If the IR holds for ASP.NET, simpler frameworks (Express, Gin) slot in without IR churn.
- ✅ Energy concentrates in one pipeline; the team (one developer) isn't context-switching across three parsers at MVP.
- ✅ The demo is concrete and shippable — a real `openapi.yaml` from a real ASP.NET project — instead of three half-done parsers.
- ⚠️ JS/TS users wait for M2+. Mitigation: README clearly marks JS and Go as "Planned"; the IR proto contract guarantees future parsers can plug in without breaking the existing pipeline.
- ⚠️ Reorders the `Supported Frameworks` matrix in `README.md`; no commitment to a future order beyond .NET-first.
