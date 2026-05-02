# ADR-0006: Vitest for testing

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1 used Jest + ts-jest. Jest's ESM story is still rough, and ts-jest is the slow path. V2 is ESM-first (`type: module`, NodeNext resolution) and needs sub-second test runs to keep the inner loop tight.

## Decision

Use **Vitest** with a workspace-level `vitest.config.ts`. Coverage via `@vitest/coverage-v8`. Threshold: branches 60 / functions 70 / lines 70 / statements 70 (matches V1).

## Consequences

- ✅ Native ESM, no transformer required.
- ✅ Fast cold start; watch mode is instant.
- ✅ `vitest workspace` config can shard per-package later.
- ⚠️ Fewer matchers than Jest's expansive ecosystem; we have not hit a gap so far.
- ⚠️ Snapshot file format differs from Jest — no concern, this is a greenfield repo.
