# ADR-0008: Commander.js + picocolors for the CLI

**Status:** Accepted
**Date:** 2026-05-02

## Context

The CLI needs argument parsing, subcommands, help text, and minimal terminal styling. We considered yargs (heavyweight, awkward API) and clack (interactive prompts, not our use case).

## Decision

- **Commander.js** for arg parsing and subcommands.
- **picocolors** for terminal colors (10× smaller than chalk; same API).
- **ora** for spinners.

## Consequences

- ✅ Mature, well-known, predictable behavior.
- ✅ Tiny install footprint: helps `npx @astronaut/cli` cold-start time.
- ⚠️ Commander's TypeScript types for option chaining are awkward; we wrap commands in typed helpers.
