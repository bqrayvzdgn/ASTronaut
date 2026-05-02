# ADR-0003: CLI-first MVP, webhook deferred to V2

**Status:** Accepted
**Date:** 2026-05-02

## Context

V1 led with the GitHub App / webhook flow. The pipeline was production-shaped before the parsers were good. As a result, we built a queue, a token cache, a rate limiter, and a PR service while the Express parser was still emitting `any` for request bodies. Effort spent on plumbing did not improve the core product.

## Decision

V2 ships a **CLI first** (`@astronaut/cli`). The webhook flow is explicitly out of V1 scope. Once the parser registry, IR, and generator are mature, the webhook becomes a thin adapter that calls the same `detectAndParse` pipeline.

## Consequences

- ✅ Tight feedback loop: every parser change is testable with `astronaut analyze ./fixtures/...`.
- ✅ Early users get value without installing a GitHub App.
- ✅ Multi-tenancy, queue, rate limiting all deferred — they are standard infra patterns and not on the critical path.
- ⚠️ Production-scale concerns (idempotency, distributed rate limiting) surface late. Mitigation: address them in V2 with the maturity of the core in hand.
