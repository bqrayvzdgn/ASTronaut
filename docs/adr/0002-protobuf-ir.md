# ADR-0002: Protobuf as the IR contract

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1's `ParseResult` was a plain TS interface. The Go and .NET analyzers replicated the shape by hand — drift was inevitable, and changing the shape was painful. V2 needs a single source of truth that all parsers (current and future, including out-of-tree contributors) can target without touching this repo's TypeScript.

## Decision

Define `ParseResult` and friends in **`proto/parser.proto`** (proto3, package `astronaut.v1`). All parsers emit the proto's canonical JSON mapping over stdout. Consumers parse and validate against the shape via `@astronaut/core`.

## Consequences

- ✅ Single source of truth; future Go/Java/Python parsers can codegen stubs.
- ✅ gRPC migration in V2 is free — same `.proto`, different transport.
- ✅ Versioning discipline (additive after v1.0.0).
- ⚠️ TS types are currently hand-aligned with the proto; we accept this for v0.x and plan to wire ts-proto / @bufbuild later. A round-trip test will catch drift.
- ⚠️ No protoc dependency for users today (we generate JSON directly); revisit once we add cross-language stubs.
