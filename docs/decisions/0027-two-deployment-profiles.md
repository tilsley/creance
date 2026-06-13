# ADR-0027: Two deployment profiles — cheap AWS-native vs full-k8s, one contract

- **Status:** Accepted, amended by [0028](0028-own-the-gateway-engine.md) (realizes the cost curve of [0024](0024-build-vs-buy-managed-agent-platforms.md) + ports of [0003](0003-ports-and-adapters.md); the gateway wire switch of M4 is the mechanism). **Amendment:** the two profiles survive, but they no longer differ by gateway — the Bun gateway is the single live engine in both (not the frozen reference this ADR named), so the TS/Python drift risk below is moot. The cheap-vs-full split is now purely backing (DynamoDB + offline JWT vs Postgres/Redis + mesh + OPA).
- **Date:** 2026-06-06

## Context

Ports & adapters ([0003](0003-ports-and-adapters.md)) make every backend swappable, and the
cost curve ([0024](0024-build-vs-buy-managed-agent-platforms.md)) says different points on it
win at different scales. M4 made the **gateway itself** swappable (`INFERENCE_GATEWAY_WIRE`:
`bespoke` = the Bun `/v1/generate` gateway, `openai` = LiteLLM). That opens a combinatorial
space of adapter configs — which is a liability if every deploy is a bespoke soup of env vars.

The fix is to **name two tested profiles** that match the two real operating points: a
cost-sensitive POC / low-volume mode, and a scale / rich-governance mode. Same platform, two
faces — not two products.

## Decision

**Ship two deployment profiles behind one contract; select by env bundle, not per-component
tuning.**

| | **Cheap AWS-native** | **Full k8s** |
|---|---|---|
| Gateway | Bun `/v1/generate` (`WIRE=bespoke`) | LiteLLM (`WIRE=openai`, multi-format, routing) |
| Spend store | DynamoDB on-demand (~$0 idle) | Redis/ElastiCache hot + Postgres SoR |
| Authn | offline JWT / IAM-SigV4 | Istio mesh-trust (mTLS/SPIFFE) |
| Authz | in-gateway | OPA sidecar (pushed bundle) |
| Compute | serverless / scale-to-zero | always-on EKS + Karpenter |
| Optimizes | **idle cost, ops simplicity** | **scale, features, per-unit cost** |

- **The driver for the cheap mode is true scale-to-zero.** A Python LiteLLM proxy doesn't fit
  a Lambda/ECS-to-zero shape; the tiny Bun gateway does. That — not merely "fewer sidecars" —
  is what earns the Bun gateway its keep (if the driver were only fewer sidecars, a
  *LiteLLM-minimal* config would do and the second gateway wouldn't pay for itself).
- **One contract across both.** Same ports, same claim shape, and the same **invariants**:
  verified identity (R1) and a real-time budget hard-stop (R2) hold in *both* profiles. Only
  the *richness* differs — cheap = single wire, no OPA/mesh; full = multi-format, OPA policy,
  mesh mTLS. This is the [walkthrough](../walkthrough.md)'s invariant-vs-value split applied to
  deployment: *that* the gate exists is invariant; *how rich* it is, is the profile.
- **A shared conformance suite** asserts the gate contract (identity → claim → reserve → 402 /
  admit) against *both* gateways, so the two impls can't silently drift into two products.

## Consequences

- **+** Two named, testable operating points; ride the cost curve by switching the profile, not
  rewriting. Same agent code in both.
- **+** The Bun gateway has a real job (cheap-mode scale-to-zero), so M4 *added* LiteLLM rather
  than retiring it — both live behind the `InferenceProvider` port.
- **−** Two gateways ⇒ the gate logic lives in **TS and Python** and can drift. Mitigate: the
  shared conformance suite, and treat the Bun gateway as a **frozen reference** (don't chase
  wire-format parity — it's deliberately single-wire).
- **−** Two integration paths to validate, and two infra footprints to operate.
- **−** Cheap mode offers **fewer guarantees** (no OPA policy, no mesh mTLS, single wire). Be
  explicit with tenants about which guarantees are invariant (R1/R2) vs profile-specific, so
  "we run the cheap profile" is never mistaken for "we dropped isolation/budget."

## Relationship

Realizes the cost curve of [ADR-0024](0024-build-vs-buy-managed-agent-platforms.md) and the
ports of [ADR-0003](0003-ports-and-adapters.md); the M4 gateway wire switch is the mechanism.
The full-mode hot path is [ADR-0026](0026-gateway-hot-path-authn-authz-budget.md); the
cheap-mode spend store is DynamoDB on-demand ([0023](0023-memory-backends-postgres-redis.md)/
[0025](0025-cost-allocation-in-the-ledger.md)). One-liner: **two profiles, one contract — cheap
AWS-native for ~$0-idle/scale-to-zero, full-k8s for scale and rich governance, with R1+R2
invariant across both.**
