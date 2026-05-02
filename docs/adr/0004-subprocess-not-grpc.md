# ADR-0004: Subprocess + JSON IPC (gRPC deferred)

**Status:** Accepted
**Date:** 2026-05-02

## Context

The Go and .NET analyzers run out-of-process. The plan eventually targets gRPC parser microservices for the SaaS deployment, but for the CLI a long-lived gRPC server is overkill: the CLI starts, parses, exits.

## Decision

For V1, parsers are invoked as **child processes** (spawn) and communicate via JSON on stdout. The `.proto` file remains the schema; we emit/consume its canonical JSON mapping. gRPC migration is deferred to V2 (where parser containers are long-lived and the hot path matters).

## Consequences

- ✅ Zero gRPC infra in the CLI; one less moving part for users.
- ✅ Same `.proto` works when we switch transports — no type churn.
- ✅ Trivially debuggable: `astronaut-go-analyzer ./repo | jq`.
- ⚠️ Per-invocation cold-start cost (Node CLI + .NET process). Acceptable for one-shot CLI runs; revisit for the SaaS path.
- ⚠️ Stdout pollution risk — analyzers must write logs to stderr only.
