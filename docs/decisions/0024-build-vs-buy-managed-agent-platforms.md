# ADR-0024: Build vs buy — managed agent platforms vs the agent-os governance shell

- **Status:** Proposed — the *buy the engine* conclusion is reversed **for the gateway** by [0028](0028-own-the-gateway-engine.md) (the policy was always ours, the bought engine became dead weight); the managed-platform-as-adapter stance for sandbox/tools, and the cost-curve framing, are untouched
- **Date:** 2026-06-01

## Context

Managed agent platforms matured fast — **Bedrock AgentCore**, **Claude Managed Agents**
(beta, 2026-04), and **Gemini Enterprise Agent Platform** (Vertex Agent Engine) each now
offer managed sandboxes, tools, credentials, tracing, memory, and per-tenant policy as a
turnkey, pay-as-you-go service with **no upfront cost**. That raises the obvious question:
should we go *all-in* on one and delete agent-os, rather than self-host?

This ADR records the build-vs-buy analysis. The full cost model + per-port vendor survey
lives in [costs.md](../costs.md); this is the decision and its rationale.

## Decision

**Don't choose all-in-managed vs all-self-hosted. Use managed platforms as adapters behind
the ports ([ADR-0003](0003-ports-and-adapters.md)); keep the thin agent-os governance shell
that supplies what they structurally don't.** Two findings drive this:

**1. Managed platforms don't meet all nine [requirements](../platform.md).** They cover ~6–7
well (sandbox R3, identity R4, observability R7, content R8, A2A R9), but two structural gaps
remain — and they're the two that justify agent-os existing:
- **R2 — real-time per-tenant budget hard-stop.** None offers a native pre-flight inference
  cap that stops a run mid-flight (AgentCore *Payments* is preview + commerce-oriented; Claude
  MA exposes only org-level limits). This is exactly [ADR-0019](0019-inference-gateway.md).
- **R6 — portability / no lock-in.** "All-in" *is* lock-in (Claude-only / AWS-only / GCP-only).
- R1/R5 (multi-tenant isolation + onboarding-as-policy) are only partial.

So even if managed were free, it wouldn't meet R2/R6 alone.

**2. Cost is a curve, not a verdict** (figures + worked example in [costs.md](../costs.md)):
- **Tokens are a wash** — paid to the model provider either way. The controllable variable is
  harness + sandbox compute + idle + ops.
- **Managed wins at POC scale**: ~$0 idle, no upfront, zero ops.
- **Self-host wins at scale**: managed compute is ~2× self-host on-demand and ~5–7× spot, so at
  hundreds of agents (high utilization) self-host on spot/reserved is **~2–3× cheaper**;
  break-even is ~15% utilization on spot. The genuine "upfront" cost is the *engineering to
  build and run the sandbox fleet*, deferred by starting managed.

The `SandboxProvider` port ([ADR-0022](0022-sandbox-backends-for-coding-agents.md)) lets us
**ride that curve without a rewrite**: start managed, swap to self-hosted (Kata/gVisor on EKS)
when sustained volume crosses the ops cost. The agent-os shell — gateway, budget hard-stop,
identity, tenancy — stays constant across the swap and provides R2 + R6.

## Consequences

- **+** Cheapest-today execution at every scale (managed at POC, self-host at volume) with no
  agent-code rewrite; the two missing requirements (R2, R6) are always covered by the shell.
- **+** Validates the existing strategy: agent-os isn't competing with AgentCore/Claude MA —
  it's the thin portable layer that consumes them.
- **−** We maintain the shell + the adapter seams rather than offloading everything to one vendor.
- **−** The crossover decision (when to self-host the sandbox fleet) needs real utilization data;
  premature self-hosting loses to managed on both cost and ops.

## Relationship

Builds on [ADR-0006](0006-agentcore-execution-environment.md) (buy execution, behind a port),
[ADR-0003](0003-ports-and-adapters.md) (the swap seam), [ADR-0022](0022-sandbox-backends-for-coding-agents.md)
(sandbox backends), and [ADR-0019](0019-inference-gateway.md) (the R2 hard-stop managed lacks).
Cost model + vendor survey: [costs.md](../costs.md).
