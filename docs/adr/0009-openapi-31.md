# ADR-0009: Emit OpenAPI 3.1 (not 3.0.3)

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1 emitted OpenAPI 3.0.3. The 3.0.x family pre-dates JSON Schema 2020-12, so it lacks `oneOf`/`anyOf`/`allOf` ergonomics, awkwardly handles nullability via `nullable: true`, and misses several modern fields (`examples`, `webhooks`).

## Decision

V2 emits **OpenAPI 3.1.0**. Schemas are full JSON Schema 2020-12. Nullability uses `type: ["string", "null"]`.

## Consequences

- ✅ Composite schemas are first-class — needed to model union/intersection TS types and Roslyn's polymorphic responses.
- ✅ Modern editor / Redoc / Stoplight all support 3.1 today (the migration risk is past).
- ⚠️ A small fraction of legacy validators still expect 3.0.x. We do not target them; if pressure builds, a `--openapi 3.0` flag is feasible later.
