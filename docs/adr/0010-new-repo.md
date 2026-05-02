# ADR-0010: New repository `astronaut-v2`

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1's repo carries hundreds of commits, a published package layout, and CI assumptions tied to the old monolithic shape. Layering the rewrite on top would require backwards-compatible scaffolding for code that nobody runs.

## Decision

Create a **new git repository** named `astronaut-v2`. Archive V1 with a README pointing here. Reuse the `ASTronaut` brand name in the new repo (keeps SEO + recognition).

## Consequences

- ✅ Clean history; ADRs are the canonical record of decisions.
- ✅ No legacy code paths to defend.
- ✅ npm package names (`@astronaut/*`) are fresh — no version cliff to manage.
- ⚠️ Issue and PR history do not migrate; we will link out from V1's archive note.
- ⚠️ Old contributors need to be re-pointed at the new repo.
