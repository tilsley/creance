# ADR-0026: Gateway hot-path — edge-offloaded authn, cached grants, durable Postgres budget reserve

- **Status:** Proposed (refines the gateway of [0019](0019-inference-gateway.md); realizes the Redis hot tier of [0023](0023-memory-backends-postgres-redis.md) for the budget counter; sharpens [0024](0024-build-vs-buy-managed-agent-platforms.md) with the LiteLLM OSS/enterprise boundary; builds on the authn/authz split of [0015](0015-split-authn-authz-ports.md) + mesh-trust of [0009](0009-gate-identity-and-governance.md)) — the hot-path **rules** (edge authn, cached grants, durable worst-case reserve) carry over to [0028](0028-own-the-gateway-engine.md)'s owned TS engine; the LiteLLM-OSS-hook *implementation* this ADR assumed is retired
- **Date:** 2026-06-05

## Context

M2 of the LiteLLM pivot ([0024](0024-build-vs-buy-managed-agent-platforms.md)) — mapping a
**verified** identity onto the tenant — surfaced the real production question: every model call
must pass **authn → authz/grant → budget**, and the gateway is in-path for *every* call. The naive
M2 hook does a **DynamoDB read per request** for the claim (~5–10 ms) plus a spend-store touch — two
serial remote round-trips on the hot path, per call.

**Recalibration.** On an AI gateway the model call dominates: hundreds of ms to seconds. Relative to
a ~2000 ms Bedrock call, a sub-ms auth check is noise. So the rule is not "no auth work" but:

> **No serial *remote* round-trip per request.** A crypto verify (µs) and local-memory lookups
> (sub-ms) are free; a DB / remote-authz call on the hot path is what to eliminate.

**Landscape (LiteLLM 1.87.0, verified in-tree):**

| Capability | Tier | Note |
|---|---|---|
| OIDC/JWT authn (`enable_jwt_auth`, claims→team) | **Enterprise** | `"JWT Auth is an enterprise only feature"` (`user_api_key_auth.py:877`) |
| `custom_auth` + pre/post-call hooks | **OSS** | the seam we use — authn *and* worst-case budget buildable for free, in-process |
| Per-key/team budgets + RPM/TPM | OSS | **accumulation-only** (`_virtual_key_max_budget_check`, spend-under-cap *after* the fact); documented fail-open bugs |
| **Worst-case pre-flight dollar admission (R2)** | **none** | absent at *every* tier — not LiteLLM's model. The thing we must build. |

Two takeaways: native JWT authn is *buyable* (enterprise) but the OSS `custom_auth` hook does the
same verification for free and keeps us portable ([R6](../platform.md)); and the worst-case hard-stop
is **unbuyable at any tier**.

## Decision

**A three-layer hot path, each layer avoiding a per-request remote round-trip. Build authn + the
worst-case budget in LiteLLM's OSS hooks; offload authn to the edge where possible; keep grants in
memory; put the one irreducible per-request state op on Redis.**

1. **Authn — stateless, at/near the edge (no DB).**
   - *In-cluster:* trust the **Istio mesh-forwarded verified identity** (mTLS/SPIFFE) — the
     [`MeshTrustAuthenticator`](../../packages/core/src/adapters/mesh-trust-authenticator.ts) pattern.
     The mesh already authenticated the workload; the gateway reads the verified header. ~zero cost.
   - *Otherwise:* **offline JWT verification** against a **cached JWKS** — the exact check STS already
     does for your IRSA pods (see [the SA-token model](0009-gate-identity-and-governance.md)). Non-k8s
     callers via JWT / IAM-SigV4.
   - Implemented in LiteLLM's **OSS `custom_auth`** hook (not the enterprise `enable_jwt_auth`) — free,
     portable, no license.

2. **Authz / grant — local, not per-request remote.**
   - The claim (grant + budget + model, [ADR-0021](0021-inference-onboarding-policy.md)) is read from
     its store (Dynamo/CRD via the `ClaimSource` port) but **cached with a short TTL** — in-process per
     replica, or **Redis** as the shared cache across replicas (the
     [ADR-0023](0023-memory-backends-postgres-redis.md) hot tier) — or evaluated by an **OPA sidecar
     fed a pushed data bundle** (the org's stack). The store stays the source of truth; the hot path
     reads memory. **Default-deny** when no claim resolves.

3. **Budget — atomic *and* durable in one Postgres `UPDATE` (fast enough).**
   - Worst-case pre-flight **reserve/settle as a single Postgres conditional `UPDATE`**
     (`spent + delta ≤ ceiling` — atomic, ACID-durable, one ~1–3 ms in-cluster round-trip;
     [ADR-0023](0023-memory-backends-postgres-redis.md)). Financial state stays durable, **not** on a
     losable Redis counter; per-tenant/month contention is low, so Postgres wins on the path that
     matters. Redis is reserved for the **grant cache** (layer 2) and ephemeral **per-session
     rate-limit** counters — not the money. The worst-case admission logic stays ours — no LiteLLM
     tier provides it.

Resulting hot path: **verify signature (µs) → cached grant (sub-ms) → Postgres conditional-`UPDATE`
reserve (~1–3 ms) → model (seconds).** The claim store is read only on a cache miss; the spend rollup
is async — neither sits serially in the critical section.

## Consequences

- **+** Per-request overhead is dominated by the model call; authn/authz/budget add sub-ms when warm.
- **+** authn + the worst-case hard-stop live in **OSS hooks** — no enterprise licence, no lock-in,
  portable across engines (swap LiteLLM out, keep the hooks' logic).
- **+** Budget reserve is a single durable Postgres `UPDATE` (atomic + ACID), fast enough beside the
  model call — no separate financial counter to keep consistent. Redis **realizes ADR-0023's hot tier**
  for the grant cache + rate-limit, not the money (M1's DynamoDB counter stays the POC stand-in).
- **+** Grant changes propagate within the cache TTL / OPA bundle-refresh window — tunable latency vs
  freshness.
- **−** **Eventual consistency:** a revoked or lowered grant lags by the TTL / bundle refresh. Mitigate
  with a short TTL or push-invalidation; accept that a grant change isn't instantly observed.
- **−** More moving parts on the path: Redis (hot) + Postgres (SoR) + an in-process cache, vs the naive
  single-Dynamo read.
- **−** Mesh-trust authn covers **in-cluster** callers only; non-k8s callers still need the JWT/SigV4
  verifier (a second adapter behind the port).
- **−** We forgo LiteLLM's native (enterprise) JWT auth, so we maintain our own verify code — small,
  but ours.
- **−** The budget reserve is an in-cluster DB round-trip (~1–3 ms), not sub-ms — immaterial beside the
  model call, but it does put Postgres on the critical path; size the connection pool accordingly.

## Relationship

Builds on the authn/authz **port split** of [ADR-0015](0015-split-authn-authz-ports.md) and the
**mesh-trust** authenticator of [ADR-0009](0009-gate-identity-and-governance.md); reads grants through
the `ClaimSource` port of [ADR-0021](0021-inference-onboarding-policy.md). **Realizes** the
[ADR-0023](0023-memory-backends-postgres-redis.md) split on the gateway hot path — Postgres
conditional-`UPDATE` for the budget reserve, Redis for the grant cache + rate-limit — superseding the
per-request DynamoDB read of the M1/M2 POC (M1 stays on DynamoDB as the $0-idle stand-in for now). **Refines** the gateway of
[ADR-0019](0019-inference-gateway.md) (its hot-path realization) and the buy-vs-build of
[ADR-0024](0024-build-vs-buy-managed-agent-platforms.md): LiteLLM's OSS hooks carry authn + the
worst-case budget for free, its native JWT authn is an enterprise upsell we decline, and R2 (worst-case
pre-flight) is confirmed unbuyable at any tier. One-liner: **the model call dominates latency, so the
gateway authenticates at the edge, keeps grants in memory, and reserves budget with one durable
Postgres `UPDATE` — paying a remote round-trip only off the critical path.**
