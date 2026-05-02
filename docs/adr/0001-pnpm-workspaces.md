# ADR-0001: pnpm workspaces for monorepo

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1 was a single-package repo with `analyzers/` as side projects. V2 is a monorepo: shared IR types, multiple parser packages, and a publishable CLI. We need a workspace tool that handles cross-package linking, hoisting, and a published-vs-private distinction.

## Decision

Use **pnpm workspaces** (no Turborepo yet).

## Consequences

- ✅ Disk-efficient (content-addressed store).
- ✅ Strict by default — packages cannot reach undeclared dependencies.
- ✅ Native `pnpm -r` for fan-out scripts; Turborepo can be added later if build graph becomes a bottleneck.
- ⚠️ Contributors must install pnpm (`corepack enable` covers it).
- ⚠️ Some IDEs need configuration tweaks for the symlinked node_modules layout.
