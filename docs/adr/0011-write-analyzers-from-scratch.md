# ADR-0011: Write Roslyn and Go AST analyzers from scratch

**Status:** Accepted
**Date:** 2026-05-03

## Context

[ADR-0005](./0005-salvage-analyzers.md) decided to copy V1's `.NET` and `Go` analyzer sources into V2 and update only the IR layer. After scoping the M4/M5 migration work, that approach lost most of its appeal: V1 analyzers emit V1's `RouteInfo` shape, use V1 idioms for diagnostics and DTO handling, and carry assumptions from a pipeline that no longer exists. Aligning them to the V2 IR — proto-defined, OpenAPI 3.1-native, with `sharedSchemas` dedup and the new `Constraints`/`AuthInfo`/`ResponseInfo` records — costs nearly as much as a rewrite and leaves V1 idioms scattered through code authored against V2 conventions.

## Decision

Author the Go and .NET analyzers fresh against `proto/parser.proto` and the IR types in `packages/core/src/ir.ts`. No traversal logic is ported from V1. The V1 repository remains read-only reference material for edge cases (route template parsing quirks, DTO unwrapping patterns), not a source of code.

## Consequences

- ✅ Analyzer code matches V2 conventions from line one (FrameworkAdapter seam, IR shape, file layout, diagnostic codes).
- ✅ No V1 baggage — no half-aligned types, no dead helpers, no "this looked weird but it works in V1" comments.
- ⚠️ Loses ~3 weeks of debugged AST traversal that V1 already paid for. Mitigation: keep V1 as read-only reference; revisit specific tricky regions (Gin's middleware-injected route prefixes, ASP.NET's `[ApiVersion]` discovery) by reading V1 code, not copying it.
- ⚠️ Risk of re-introducing bugs V1 already fixed. Mitigation: a regression fixture corpus drawn from V1's test cases.

Supersedes [ADR-0005](./0005-salvage-analyzers.md).
