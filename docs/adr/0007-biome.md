# ADR-0007: Biome for lint + format

**Status:** Accepted
**Date:** 2026-05-02

## Context

ESLint + Prettier is two tools, two configs, two failure modes, and a slow lint pass on a monorepo. Biome bundles both into one Rust binary with a single config.

## Decision

Use **Biome** (`biome.json`) for linting and formatting across all packages.

## Consequences

- ✅ One config, one binary, sub-second runs.
- ✅ Sensible defaults; we override only `noExplicitAny: error` and import-protocol style.
- ⚠️ Biome's lint rule coverage is narrower than ESLint's. We accept the trade-off; if a missing rule bites, we revisit.
- ⚠️ Some niche TS plugins (eslint-plugin-import, etc.) have no Biome equivalent yet. Same trade-off.
