# ADR-0020: Sandbox execution model — tool-executor (A) and sandboxed-agent (B)

- **Status:** Accepted — built in slice 4 of [ADR-0019](0019-inference-gateway.md) (commit `da66984`)
- **Date:** 2026-05-31

## Context

The `do` primitive (running model-directed code/commands) is the dangerous part of an agent —
it must be isolated. The `SandboxProvider` port is that isolation seam. Two distinct ways to use
a sandbox surfaced, and they're architecturally different — worth naming so we don't conflate
them (and so a foreign agent like the GitHub Copilot CLI has a home without warping the platform).

A useful disentangling first: **`think` (inference) is a network call** (governed by the gateway,
ADR-0019); **`do` (execution) is what the sandbox contains**; the **agent loop** is the
orchestration that interleaves them. "The LLM execs code in the sandbox" really means *the model
decides, and that code runs in the sandbox* — the model itself isn't in the sandbox.

## Decision

The `SandboxProvider` port is the `do` execution surface; pick the backend by adapter
(`local` for dev, `agentcore`, **`e2b`** — slice 4). On top of it, two execution **modes**:

**Model A — sandbox as tool-executor (default).** The runtime drives the think/do loop; each
*individual* tool call (`run_cmd`/`run_code`) executes in the sandbox. The sandbox holds no agent
logic and no model credentials — it's purely the `do` surface. Full step-level governance: `guard`
screens each step, `record` logs each turn, the gateway meters each inference call.

**Model B — sandboxed agent (a special agent `kind`).** A self-contained delegated agent (e.g.
Copilot CLI) runs *inside* the sandbox; the runtime launches it (`AgentSpec.kind: "sandboxed"`,
`runSandboxedAgent`). The locked principle:

> **The gateway governs `think`; the sandbox governs `do`.** A B-agent's inference egress is
> pointed at the gateway (it speaks to the gateway), and its execution stays in the sandbox. We do
> NOT route the exec env through the gateway.

So budget/identity/audit still bind on inference (gateway), isolation binds on execution (sandbox).
From the platform's view a B-agent is *one opaque `do`* — "run a delegated sub-agent" — so it adds
**no new primitive and no new control**; it's a composition (L1), governed at the same fixed hooks.

**The non-negotiable for B:** the sandbox's *only* sanctioned model egress is the gateway. Today
that's routing (inject `INFERENCE_GATEWAY_URL` into the sandbox); **hard egress lockdown** (a
NetworkPolicy / E2B firewall that blocks any other outbound) is the production requirement — without
it, a B-agent can reach a model directly and bypass budget/identity entirely.

## Consequences

- **+** A foreign agent (Copilot CLI) gets a home as a contained agent kind, with the platform's
  controls binding at the boundary — the messy provider coupling is quarantined in one adapter/kind.
- **+** Model A keeps full step-level governance; Model B trades that for delegation.
- **−** B's controls are **coarser**: the inner loop is opaque, so `guard`/`record`/`maxSteps`
  degrade from per-step to per-boundary; budget still binds (every inference call hits the gateway),
  audit is per-run.
- **−** B's safety **depends entirely on egress lockdown** — the one thing that must not be misconfigured.
- **−** Two execution paths to maintain (the loop, and launch-and-watch) with different granularity.

## Relationship

Realizes the **sandbox** half of the primitives/controls model under [ADR-0019](0019-inference-gateway.md)
(built in slice 4: the E2B `SandboxProvider` adapter + the `sandboxed` agent kind). The choice of
backend (E2B vs AgentCore vs self-hosted gVisor/Firecracker — [ADR-0002](0002-gvisor-as-default-untrusted-tier.md))
is an adapter swap. A foreign CLI that speaks OpenAI/Copilot needs an **OpenAI-compatible gateway
endpoint** for its `think` to route through the gateway — the documented follow-up.
