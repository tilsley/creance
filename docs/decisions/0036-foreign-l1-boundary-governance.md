# ADR-0036: The foreign-L1 agent — governed at the boundary, not in the loop

- **Status:** Proposed (names the governance profile of [0033](0033-claude-code-hosted-runner.md)'s runner; positions it against [0019](0019-inference-gateway.md)/[0020](0020-sandbox-execution-model.md)'s execution models; refines what R2 means from [0004](0004-cost-governance.md)/[0013](0013-inference-cost-enforcement.md))
- **Date:** 2026-07-05

## Context

Hosting Claude Code as an execution kind ([0033](0033-claude-code-hosted-runner.md)) quietly
introduced a resource-model anomaly that the delivery ADRs didn't name. It's worth naming,
because the next foreign harness we host will hit the same shape and the model should already
have a slot for it.

The platform's two governance invariants are R1 (verified identity) and R2 (real-time budget),
held across both deployment profiles ([0027](0027-two-deployment-profiles.md)). Until now they
were enforced **inside the L1 loop**: the runtime drives think/do turn by turn, so it routes
`think` through the inference gateway (identity-bound, budget-admitted per turn —
[0019](0019-inference-gateway.md)) and confines `do` to the sandbox. Even the sandboxed-agent
(Model B, [0020](0020-sandbox-execution-model.md)) — a self-contained delegated agent — keeps
its **inference egress pointed at the gateway**, so its `think` is still governed; the gateway
is its only sanctioned model egress ([0029](0029-governed-egress-choke-points.md)).

The claude-code runner breaks that assumption. It is an **L2 agent** (registered, identity-
bearing, a unit of governed work) that **brings its own L1** — Claude Code *is* the loop. The
platform does not drive its turns, so none of the in-loop governance applies:

- its `think` goes straight to `api.anthropic.com` (via the sidecar's credential injection),
  **not** through the inference gateway — no per-turn budget admission, no per-turn metering;
- its `do` (file edits, bash, builds) happens inside the container, unobserved turn by turn.

Between `RunTask` and exit it is a **black box**. And the tension is forced, not incidental:

**You cannot route the subscription's think through the inference gateway.** The gateway speaks
Bedrock — tenant IAM identity, per-token billing, worst-case budget reserve. The Max
subscription is a different provider, different auth (OAuth), different (zero) billing path.
Making claude-code's think governed *the Model B way* means dropping the subscription and paying
Bedrock per token — which discards the $0 marginal cost that was the whole reason to host the
subscription ([0033](0033-claude-code-hosted-runner.md)). So it is a genuine either/or:

> **$0 cost with boundary-only governance (subscription), OR in-loop governed think (Bedrock via
> the gateway, per-token cost) — not both.**

The sidecar's `/v1/*` leg ([0034](0034-egress-sidecar-credential-injection.md)) is exactly where
that switch lives: today it targets `api.anthropic.com`; pointing it at the gateway is the
one-line change that buys governed think and costs the subscription.

A second consequence: with a subscription, **R2 as a dollar cap is meaningless** — a $0 run
settles against nothing. The governable resource isn't money, it's *usage*.

## Decision

**Name the foreign-L1 agent as a distinct execution model with its own governance profile:
governed at the boundary (admission + egress), not in the loop. For it, R2 is re-expressed as
an admission quota, not a dollar budget.**

Three execution models now sit behind the one dispatch seam, by *where governance lives*:

| Model | Loop owner | `think` | `do` | R1 | R2 |
|---|---|---|---|---|---|
| L1 loop executor | platform | gateway (per-turn) | sandbox | admission | per-turn dollar admission + settle |
| Sandboxed agent (B) | delegated, in sandbox | **gateway** (egress-routed) | sandbox | admission | at the think egress |
| **Foreign-L1 (claude-code)** | **foreign harness** | **direct to provider** | in container | **admission** | **admission quota (not dollars)** |

- **Governance moves to the boundary.** What the platform cannot meter inside a foreign loop it
  governs at the two boundaries it *does* own: the **gate** on the way in (R1 — identity
  verified, authz decides, quota checked; [0009](0009-gate-identity-and-governance.md)/[0015](0015-split-authn-authz-ports.md))
  and the **egress sidecar** on the way out (credentials held + capabilities bounded;
  [0034](0034-egress-sidecar-credential-injection.md)/[0029](0029-governed-egress-choke-points.md)).
  Coarse, not per-turn — the honest trade for hosting a best-in-class foreign harness at $0.
- **R2 becomes an admission quota.** When cost is subscription-based, the scarce resource is
  runs/concurrency, not dollars. The gate gains a per-tenant claude-code quota (runs per period
  and/or max concurrent), checked before `RunTask` — admission-time, so it needs no per-turn
  accounting and reuses the existing gate seam. `costUsd` on the run stays, re-scoped as
  **attribution/visibility** ("which tenant is consuming the subscription"), explicitly not R2
  enforcement.
- **The either/or is a documented dial, not a defect.** The sidecar `/v1/*` target is the seam:
  subscription→provider (default, $0, boundary-governed) vs subscription-dropped→gateway
  (per-token, in-loop-governed). A tenant or profile could choose per agent later.

## Consequences

- The model stays legible for the *next* foreign harness (Codex, Aider, a bespoke agent): it
  lands as another foreign-L1 agent, and its governance story is pre-written — admission quota +
  egress choke points, no pretense of in-loop metering.
- Honesty about the gap: a foreign-L1 run is unobserved between admission and exit. Mitigations
  are coarse and already in place — `--max-turns`, the hard timeout, the sidecar's egress bounds,
  and (to add) the admission quota. Fine-grained per-turn control is *unavailable by
  construction* for a foreign loop; that is the price of not owning the loop.
- Deferred, unblocked by this framing: (1) the gate quota check (the R2-equivalent — small, the
  gate seam already exists); (2) notional-cost roll-up for subscription attribution; (3) the
  gateway-target switch offered as a per-agent option if a tenant wants governed think and will
  pay Bedrock for it. None are required to keep the current runner correct — this ADR is the
  clarification that makes them nameable.
