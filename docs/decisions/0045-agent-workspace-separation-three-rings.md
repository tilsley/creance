# ADR-0045: Agent/workspace separation — three rings, the mid-2026 field, and our mapping

- **Status:** Accepted (validates [0006](0006-agentcore-execution-environment.md)/[0020](0020-sandbox-execution-model.md)/[0022](0022-sandbox-backends-for-coding-agents.md)'s sandbox separation and [0033](0033-claude-code-hosted-runner.md)/[0036](0036-foreign-l1-boundary-governance.md)'s agent-in-sandbox lane against the 2026 field; consumes [0042](0042-agentcore-managed-profile.md)'s per-run dispatch)
- **Date:** 2026-07-18

## Context

The platform runs two execution shapes side by side: the hand-rolled loop (trusted service,
executing untrusted code through a `SandboxProvider` session) and the claude-code runner (the
whole foreign agent dropped *inside* the sandboxed Fargate task, [0033](0033-claude-code-hosted-runner.md)).
The question arose whether the second shape was a habit imported from the Copilot-SDK/headless-
Claude era rather than sound architecture — "best practice is the agent runtime separate from the
code-execution environment; the agent claims a sandbox and uses it to exec." A mid-2026 survey of
what GitHub and Anthropic actually ship answered it. Per our convention ([0037](0037-hosted-claude-code-landscape.md)),
the findings live here.

## Survey (mid-2026, sourced)

**GitHub Copilot ships BOTH shapes, first-class.** *Cloud sandboxes* (public preview, June 2026):
`copilot --cloud` runs the **entire CLI session** — loop and workspace together — in an ephemeral
GitHub-hosted Linux environment on Azure Container Apps Sandboxes; GitHub is the identity/policy/
billing layer. *Local sandboxes*: the loop stays local and only the commands it executes run
inside an isolation layer (Microsoft MXC). The copilot-sdk itself is JSON-RPC into the CLI's
server mode and exposes **no sandbox API yet** (open issue #1223) — the SDK was never the
architectural statement; the CLI's two sandbox modes are.
Refs: docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes ·
github.blog/changelog/2026-06-02-cloud-and-local-sandboxes ·
github.com/github/copilot-sdk/issues/1223

**Claude Managed Agents pulls the loop OUT of the sandbox.** The reasoning loop runs on
Anthropic's control plane; tool execution runs in a **separate stateful sandbox** (Ubuntu 22.04
container, ≤8 GB RAM / 10 GB disk, network off by default behind an allowlist proxy), with an
explicit **credential boundary** — secrets never enter the sandbox, they flow through the control
plane. Crucially the sandbox is *not* snippet-exec: it is one persistent workspace per session,
filesystem state surviving across turns.
Refs: platform.claude.com/docs/en/managed-agents/overview ·
…/managed-agents/cloud-sandboxes-reference · …/managed-agents/self-hosted-sandboxes-security

**Claude Code has no remote-exec backend — you move the whole ring or nothing.** There is no
"local agent, remote shell" flag. The options are: claude.ai/code (entire agent in an
Anthropic-managed VM, GitHub token held *outside* the sandbox), devcontainers or
`@anthropic-ai/sandbox-runtime` (wrap the whole process), or the local Bash sandbox
(Seatbelt/bubblewrap — isolates Bash subprocesses only). Anthropic's own hosting of Claude Code
is the agent-inside-sandbox shape.
Refs: code.claude.com/docs/en/sandbox-environments · …/claude-code-on-the-web · …/sandboxing

## The three-ring model

The field's converged architecture is three rings, not two:

1. **Control plane** — credentials, policy, admission, billing, orchestration. *Always* outside
   the untrusted boundary. Every vendor agrees; this is the invariant.
2. **Reasoning loop** — genuinely movable. Inside the sandbox (Claude Code on the web, Copilot
   cloud sandboxes, GitHub's Actions-hosted coding agent) or in the control plane (Managed
   Agents). Hosted products drift toward pulling it out: the loop is just model calls + tool
   dispatch, cheap to run centrally, and it keeps prompts and credentials off the untrusted box.
3. **Workspace + exec** — one *stateful, claimable sandbox per session*. Nobody ships
   per-snippet exec sandboxes for coding agents; workspace persistence is the product.

"Agent separate from sandbox" (the folk version of best practice) is really "ring 1 separate
from ring 3, with ring 2 placement a per-lane choice."

## Our mapping

| Ring | Hand-rolled loop | claude-code lane |
|---|---|---|
| Control plane | front door + gate + dispatcher (Lambda, scale-to-zero) | same, plus egress sidecar ([0034](0034-egress-sidecar-credential-injection.md)) |
| Reasoning loop | Fargate task **or** AgentCore Runtime microVM — per-run `dispatch`, stamped at admission ([0042](0042-agentcore-managed-profile.md)) | fused with ring 3 inside the task |
| Workspace | AgentCore Code Interpreter session, claimed at loop start (`loop.ts` — one session per run, closed at terminal status) | the task's own filesystem |

The hand-rolled loop is therefore already the Managed Agents shape assembled from AgentCore
parts: loop outside the workspace, workspace a stateful session, credentials held by the loop
and never materialised in the sandbox (network mode governs egress, [0022](0022-sandbox-backends-for-coding-agents.md)).
`services/sandbox-manager/README.md` — a pre-code responsibility spec — stated the principle
verbatim years-in-platform-time before the vendors converged on it: *"the sandbox is the
execution environment for untrusted code only — not the agent."*

## Decision

- **Keep the asymmetry, deliberately.** Two lanes, two ring-2 placements: the hand-rolled loop
  stays three-ring; the claude-code lane stays agent-inside-sandbox. Both are now the field's
  converged pair (Copilot ships exactly this pair), not a legacy habit.
- **Admission stamps workspace decisions; the loop claims them.** Run-level resource choices
  (today `dispatch`, tomorrow a workspace class) are validated and stamped at admission like any
  governed resource — but the *claim* happens where the loop runs. A scale-to-zero front door
  must not own long-lived sessions (it would burn the session's idle timeout during Fargate
  cold-start and split ownership across processes).
- **The gap vs Managed Agents is lifecycle, not shape.** Keep-alive, reconnect-after-restart,
  re-hydrate-on-expiry, session↔run mapping — the sandbox-manager spec, still unbuilt. That is
  backlog inside the AgentCore lean-in (Code Interpreter sessions are the primitive), not a
  posture change.
- **Per-snippet sandboxes rejected** for coding work, matching the field: the workspace session
  is the unit.

## Consequences

- The claude-code-on-Fargate lane needs no re-architecture — it is the same shape GitHub and
  Anthropic host commercially; governance stays at the boundaries per [0036](0036-foreign-l1-boundary-governance.md).
- `docs/agentcore-postures.md` gains a cross-reference; the co-located Runtime-as-box posture
  field-tested there is ring 2+3 fusion *on AgentCore*, i.e. the same lane shape.
- When workloads outgrow the Code Interpreter box, the escape hatch is an alternative
  `SandboxProvider` adapter (Fargate-task or EKS+gVisor workspace) behind the same port — a
  swap, not a rebuild ([0003](0003-ports-and-adapters.md)).
