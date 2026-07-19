# ADR-0046: The coder loop — coding as a trade of the loop-executor, not a new lane

- **Status:** Proposed
- **Date:** 2026-07-19

## Context

Today only the foreign-L1 lane codes: `kind: "claude-code"` runs ride a Fargate task (or
Cloud Run on GCP) with the egress sidecar ([0033](0033-claude-code-hosted-runner.md)/
[0034](0034-egress-sidecar-credential-injection.md)), and that lane is welded to those
substrates — the AgentCore microVM can't host it (2 vCPU/8 GB, no sidecar seat, one image
per Runtime — [0042](0042-agentcore-managed-profile.md)). Meanwhile [0042] just made the
substrate a per-run choice (`dispatch` stamped at admission, console selector), and
[0045](0045-agent-workspace-separation-three-rings.md) established that "coding agent" is a
property of ring 2 (the loop/harness) + ring 3 (the workspace) — neither of which is
substrate-bound in our architecture. The gap is plain: our OWN harness (`loop.ts`) doesn't
know the coding trade, so the substrate freedom we just built applies to everything except
the workload the user most wants (coding).

[0022](0022-sandbox-backends-for-coding-agents.md) already named the sandbox side of this;
[0037](0037-hosted-claude-code-landscape.md) already named the credential upgrade (GitHub
App per-run tokens). This ADR composes them.

## Decision

Teach the loop-executor the coding trade. In [0036](0036-foreign-l1-boundary-governance.md)'s
taxonomy this is NOT a fourth execution model — it is the loop-executor specialized, the
same harness engine with a new composition around it. Three layers:

**1. A `coder` agent kind — a registry entry, not a service.** `AgentSpec.kind: "coder"`
(beside `loop`/`sandboxed`/`claude-code`, [0038](0038-agent-onboarding-behind-the-gate.md)):
kind `loop`'s wiring plus the workspace lifecycle below. The console's repo field (today
keyed on `kind === "claude-code"`) applies to `coder` too — `Run.repo` stays the
caller-chosen, gate-authorized resource ([0034]'s attribute authz, unchanged).

**2. A coding toolset — curation, not invention.** The sandbox session already exposes
`readFile`/`writeFile`/`runCmd`/`listFiles` behind the `SandboxProvider` port; the coder
toolset curates those (plus search/diff conveniences as needed) and a prompt tuned for
edit–build–test discipline. No new ports.

**3. The workspace lifecycle — the genuinely new part.** A wrapper around the loop,
structurally the claude-code shim re-homed onto our own L1 and its sandbox session:
- after session claim: `git clone` `Run.repo` into the workspace (requires the session's
  PUBLIC/VPC egress mode and git in the sandbox image — [0022]'s note, verify per backend);
- the loop runs with cwd = the checkout;
- at terminal status (any, in a `finally` — crash included, same stance as the [0034]
  shim): commit whatever changed and push `refs/heads/run/<id>`. Never a default-branch
  write.

**Credentials — the one real design decision.** There is no sidecar seat inside a sandbox
session, so [0034]'s "secret never enters the agent" cannot hold verbatim. Phase 1 accepts
a *bounded* step down: the control plane mints a **per-run GitHub App installation token**
(fine-grained: contents+PR on the single gate-authorized repo, ~1 h expiry — the [0037]
upgrade) at dispatch and passes it into the workspace for the clone/push legs. Bounds:
one repo, short-lived, revocable, and the token's permissions replace the sidecar's
pkt-line push policy — so default-branch protection on the org side becomes load-bearing
and MUST be on. The graduation, if policy parity with [0034] ever matters, is a
**git-proxy service** (the sidecar pattern as a shared choke point the workspace pushes
through, run-token-authenticated); named here, not built.

**Governance — better than the lane we have.** Unlike foreign-L1 (boundary-only, run-quota
lane — [0036]), the coder loop is OUR L1: every think is metered through the gate on the
dollar lane, guard and telemetry see every turn, and budget enforcement is per-turn, not
admission-only. Coding stops being the least-governed workload on the platform and becomes
the most.

## Consequences

- Coding becomes substrate-orthogonal in one move: the same `coder` agent runs on Fargate,
  the AgentCore microVM, and Vertex Agent Runtime purely by the [0042] selector. First
  proof = one run per substrate through the console.
- The claude-code lane stays exactly as is — it remains the "full Claude Code experience"
  option; the coder loop is the governed, portable sibling, and honest comparison between
  them (quality vs governance vs cost) becomes possible for the first time.
- MicroVM coding inherits the field-tested bounds ([0042]): fine for script-scale changes
  on interpreted stacks; heavy builds pick Fargate in the selector. The per-run choice is
  the mitigation, not a promise the microVM can do everything.
- `AgentSpec.kind` gains a value; registry validation, console `isCodingAgent`, and the
  A2A surface need the small corresponding updates.
- Out of scope here: PR auto-opening, warm workspace caches (the [0045] sandbox-manager
  lifecycle backlog), and multi-repo runs.
