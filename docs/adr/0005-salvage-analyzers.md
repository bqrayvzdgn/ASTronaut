# ADR-0005: Salvage Roslyn and Go AST analyzers from V1

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1's `analyzers/dotnet/` (Roslyn + MSBuildWorkspace) and `analyzers/gin/` (`go/parser` + `go/ast`) took weeks to build and are functionally sound. Only their JSON output schema is tied to the V1 `RouteInfo` shape. Rewriting them from scratch would burn 3–4 weeks for no traversal-quality gain.

## Decision

Copy the Go and .NET analyzer sources into V2 as-is. **Update only the IR layer**: Go struct JSON tags and C# DTO classes are aligned with `proto/parser.proto`. Add `Constraints` extraction (Gin `binding` tags, .NET `[Range]`/`[StringLength]`/`[RegularExpression]` attributes) and shared schema dedup (request/response DTOs hoisted into `sharedSchemas`).

## Consequences

- ✅ Saves ~3 weeks of M4 + M5 effort.
- ✅ AST traversal regressions unlikely — the proven code stays.
- ⚠️ Need a side-by-side regression check on representative fixtures during the IR migration.
- ⚠️ V1 idioms in the salvaged code may not match V2 conventions; we accept the inconsistency rather than rewrite.
