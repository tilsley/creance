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
  Self-host a Valkey/Redis pod for the POC (near-zero marginal cost on a node you already run);
  the managed swap-in is **ElastiCache** (Valkey serverless ~$6/mo or a `t4g.micro` node ~$12/mo,
  **IAM auth** = keyless) — same Redis protocol behind the port, so it's an endpoint+auth change,
  but it carries **idle cost**, so adopt it only when scale/latency justify it (the cost curve).
- **Budget stays on Postgres, not Redis.** Redis `INCR` + Lua is tempting and fast, but spend
  is financial state; Postgres ACID beats Redis durability (AOF + replication), and
  per-tenant/month contention is low. Revisit only for hot per-session rate-limiting. (The POC
  currently counts spend in **DynamoDB on-demand** — a ~$0-idle stand-in whose 5–10 ms is
  immaterial next to the model call; the conditional `UPDATE … WHERE spent+delta ≤ ceiling` on
  Postgres is the durable production home — see [ADR-0026](0026-gateway-hot-path-authn-authz-budget.md).)
- **Don't split prematurely.** A coding-agent POC can run Postgres-only; introduce Redis at
  the first real queue/cache need.
- **Why not OpenSearch Serverless (yet).** A dedicated vector engine — OpenSearch Serverless
  with its vector collection — is the obvious "buy" alternative to pgvector for semantic
  retrieval, and the natural home for scale. We pass on it now for the same reason we lead
  with Postgres: **"serverless" here means no node management, not no idle cost.** OpenSearch
  Serverless bills a minimum OCU floor 24/7 (capacity stays warm to serve instantly), and that
  floor alone exceeds the whole control-plane budget (~$73/mo, [costs.md](../costs.md)) — the
  opposite of our scale-to-zero posture everywhere else (Aurora Serverless v2 at 0 ACUs,
  AgentCore pay-per-use). For POC-scale corpora pgvector in the cluster we already run is both
  cheaper at idle *and* one fewer store to operate, scope for tenant isolation, and guard.
  Revisit OpenSearch (Serverless or provisioned) only when corpus size or recall quality
  outgrows pgvector — at which point the OCU floor is amortized by real query volume and the
  managed ANN indexing earns its cost. Same `StateStore` port, so it stays an
  adapter+endpoint swap, not a redesign. (Distinct from the **observability** use of OpenSearch
  for traces in [data-log-stack.ts](../../infra/lib/data-log-stack.ts) — that's the `record`
  control, a different store for a different workload.)

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
