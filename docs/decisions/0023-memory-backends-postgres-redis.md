# ADR-0023: Memory backends — Postgres (system of record) + Redis (hot tier), not DynamoDB

- **Status:** Proposed
- **Date:** 2026-06-01

## Context

The `remember` primitive ([primitives.md](../primitives.md)) was sketched against
DynamoDB / AgentCore Memory. We don't use DynamoDB; we have **Postgres** and **Redis**.
The trap is treating "memory" as one thing — it's several tiers with different
durability, query, and latency needs. The ports already exist (`RunStore`,
`SpendStore`, the planned `StateStore`), so this is **new adapters behind existing
ports**, not an architecture change.

## Decision

Map each memory tier to the store that fits; **lead with Postgres, add Redis only for
hot-path or coordination needs.**

| Tier | Port | Store | Why |
|---|---|---|---|
| Run state | `RunStore` | **Postgres** | durable system-of-record; JSONB messages; query-by-status (worker) + recent (dashboard) |
| Budget ledger | `SpendStore` | **Postgres** | the financial hard-stop must be ACID-durable; `UPDATE … WHERE spent+delta ≤ ceiling` *is* the reserve semantics |
| Long-term / episodic memory | `StateStore` (new) | **Postgres** | durable, relational, queryable |
| Semantic retrieval | `StateStore` (new) | **Postgres + pgvector** | one durable store, mature, no extra infra |
| Working / session cache | (cache, behind callers) | **Redis** | ephemeral, TTL, fast, fine to lose |
| Coordination (run queue, locks, pub/sub) | (infra) | **Redis** | what it's built for |

- **Postgres is the system of record.** It covers `RunStore` + `SpendStore` + long-term
  memory + pgvector semantic search in one durable, transactional store you likely already run.
- **Redis is the hot tier**, reached for deliberately: a run/work queue, session-affinity
  cache, resolved-claim/config cache, or hot per-session counters where sub-ms matters.
- **Budget stays on Postgres, not Redis.** Redis `INCR` + Lua is tempting and fast, but spend
  is financial state; Postgres ACID beats Redis durability (AOF + replication), and
  per-tenant/month contention is low. Revisit only for hot per-session rate-limiting.
- **Don't split prematurely.** A coding-agent POC can run Postgres-only; introduce Redis at
  the first real queue/cache need.

## Consequences for guard

Adding long-term / semantic memory creates a **new untrusted-ingress crossing** that
`guard` ([ADR-0008](0008-guard-content-safety-primitive.md)) must cover — retrieved
memory re-enters the model context:

- **Memory poisoning is persistent injection:** text written by one run is recalled by a
  later run, so an injection survives across runs (the classic RAG vector). `guard` gains
  call sites on the memory **write** path (don't persist poison) and **read** path (don't
  trust what you recall) — beyond today's {model-in, model-out, tool-output}.
- The `ContentGuard` port is unchanged; the loop's guard **hooks** grow.

## Consequences

- **+** No new infra mandated; reuses Postgres/Redis we have; pure adapter work behind ports.
- **+** Semantic memory via pgvector keeps everything durable in one store.
- **−** New `StateStore` port + adapters to build (cross-run memory was previously deferred).
- **−** A new guard obligation (memory ingress) and a tenant-scoping/isolation obligation on
  the memory partition (a gate concern — keep one tenant's memory out of another's retrieval).

## Relationship

Realizes the `remember` primitive ([primitives.md](../primitives.md)) and supersedes its
DynamoDB / AgentCore-Memory sketch. New `RunStore`/`SpendStore` adapters sit behind the
existing ports ([ADR-0003](0003-ports-and-adapters.md)); the budget durability point refines
[ADR-0013](0013-inference-cost-enforcement.md)/[ADR-0019](0019-inference-gateway.md). Feeds
the memory-ingress crossing into [ADR-0008](0008-guard-content-safety-primitive.md).
