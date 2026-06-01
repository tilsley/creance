# ADR-0022: Sandbox backends for coding agents — pick the adapter by execution profile

- **Status:** Proposed
- **Date:** 2026-06-01

## Context

The first real use case for the platform is **coding agents**. That profile is
different from the data-analysis snippets AgentCore Code Interpreter was chosen for
([ADR-0006](0006-agentcore-execution-environment.md)): coding agents are
long-running (clone → install → build → test → iterate), need heavy egress (GitHub,
package registries) and sometimes private VPC resources (internal git, Artifactory),
want custom toolchains, and often run a **foreign agent CLI** (Claude Code, Copilot
CLI, aider) *inside* the sandbox — which is exactly [ADR-0020](0020-sandbox-execution-model.md)'s
**Model B (sandboxed agent)**.

A worry drove this ADR: "AgentCore Code Interpreter is VPC-limited — can I even use
it for coding agents?" Research (2026-06-01) shows the premise is wrong. Code
Interpreter has **three network modes**, VPC being the opt-in one:

- **Public** — no restrictions, reaches any network service; works for public GitHub +
  `pip`/`npm`/`cargo`. Easiest.
- **Sandbox** — S3 + DNS only. **Not real isolation** — DNS-based exfil is possible by
  design (Unit 42; BeyondTrust). Do not treat as a containment boundary.
- **VPC** — AWS attaches the *managed* tool to **your** VPC by creating ENIs in your
  subnets (via the `AWSServiceRoleForBedrockAgentCoreNetwork` SLR). Reaches private
  resources; add a public-subnet **NAT gateway** for internet egress too.

So "run AgentCore in my VPC because I have k8s there" is a category error: AgentCore is
a managed data plane you cannot run as EKS pods. VPC *mode* gives the managed tool a
network presence in your VPC; your cluster being in that VPC is incidental.

## Decision

**Choose the `SandboxProvider` adapter by execution profile, not one-size-fits-all.**
The port ([ADR-0020](0020-sandbox-execution-model.md)) already makes this a swap.

- **Model A — tool-executor (run-this-snippet):** **AgentCore Code Interpreter.**
  Public mode for public deps; VPC mode (+ NAT) for internal resources. Per-second
  billing, zero idle, full step-level governance. Unchanged from ADR-0006.
- **Model B — a coding-agent CLI in a box:** Code Interpreter is the **wrong** backend
  (no bring-your-own-image with a CLI baked in, ~8h session cap, opinionated runtime).
  Use one of:
  - **E2B** (already a slice-4 adapter) — custom Dockerfile templates, long sessions,
    firewall egress control. Strongest off-the-shelf fit for coding agents.
  - **Self-hosted on the existing EKS** — Kata Containers / gVisor pods with a
    **NetworkPolicy egress lockdown**. Owns the isolation tier again (the ADR-0001/0002
    path superseded *for cost* by 0006), but gives full image control and keeps data
    natively in-VPC. Justified when toolchains are custom and the cluster is already paid for.
  - **AgentCore Runtime** (≠ Code Interpreter) — AWS hosts your *container* in
    PUBLIC/VPC mode; managed, closer to Model B than Code Interpreter.

**Containment beats content for `do`.** Once an agent can run arbitrary code it can open
a socket, so no content control stops exfiltration — the **egress lockdown is the
load-bearing safety control** for coding agents, not `guard`. The ADR-0020 non-negotiable
(the sandbox's only sanctioned model egress is the gateway, enforced by NetworkPolicy /
E2B firewall) is therefore a **hard requirement** for the coding use case, not a follow-up.

## Consequences for guard

Coding agents re-shape the `guard` control ([ADR-0008](0008-guard-content-safety-primitive.md))
without changing the `ContentGuard` port:

- **Dominant threat flips to indirect injection via code.** The untrusted surface is the
  repo/dep/tool content the agent ingests (a malicious `CONTRIBUTING.md`, poisoned package
  docs), not toxic user input. Bedrock Guardrails alone is weak at this → **compose an
  injection-specialised detector** (Lakera / LLM-as-judge) on the ingress direction.
- **Guard must be code-aware.** Code legitimately contains `rm -rf`, "ignore the above,"
  and injection test fixtures; chat-tuned guard false-positives and gets switched off.
- **Model B degrades guard to per-boundary.** The foreign CLI's inner loop is opaque, so
  per-step ingress screening is lost; the **inference-gateway becomes the only guard point**
  for a B-agent, screening the assembled prompt — not the individual sources.
- **Guard is complementary, not primary, on `do`** — see "containment beats content" above.

## Consequences

- **+** Coding agents are unblocked: VPC was never a wall; A vs B maps to backend choice.
- **+** No platform change — pure adapter selection behind `SandboxProvider`.
- **−** Self-hosted Model B re-introduces the isolation tier we offloaded in ADR-0006.
- **−** Model B's safety hinges entirely on egress lockdown (the one thing not to misconfigure).
- **−** Guard fidelity for Model B is coarse; accept it or prefer Model A where step-level matters.

## Relationship

Refines [ADR-0020](0020-sandbox-execution-model.md) (which backend for which mode) and
[ADR-0006](0006-agentcore-execution-environment.md) (Code Interpreter stays the Model-A
default; coding agents add E2B / self-hosted for Model B). Feeds the guard consequences
into [ADR-0008](0008-guard-content-safety-primitive.md). Network-mode facts:
[AgentCore VPC config](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html),
[Unit 42 sandbox bypass](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/).
