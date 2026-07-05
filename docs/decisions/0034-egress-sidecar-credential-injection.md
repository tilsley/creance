# ADR-0034: Credential-injecting egress sidecar — the git choke point for hosted harnesses

- **Status:** Proposed (realizes the do-net cell of [0029](0029-governed-egress-choke-points.md) for the claude-code runner of [0033](0033-claude-code-hosted-runner.md))
- **Date:** 2026-07-05

## Context

The claude-code runner ([0033](0033-claude-code-hosted-runner.md)) needs GitHub access to work
on real repos. The naive shapes both put a write-capable credential within reach of an
autonomous agent running `bypassPermissions` on untrusted inputs (repo contents, issue text —
prompt-injection surface):

1. **PAT in the agent's env** — directly exfiltratable by anything the agent runs.
2. **PAT held by the shim, stripped from the harness's child env** — soft: shim and harness
   share a container and UID, so `/proc/1/environ` leaks it anyway.

The pattern that actually closes this (seen in microsandbox's "secrets never enter the VM"
design, and already named by [0029](0029-governed-egress-choke-points.md)): the credential
lives in a **separate egress choke point** that (a) holds the secret and (b) bounds the
capability, and the agent's traffic is *remapped* to it — no TLS interception needed.

Fargate task anatomy makes a sidecar container a real boundary: containers in one task share
localhost networking (the remap is free) but have **separate PID namespaces, env, and
filesystems** — the agent has no sanctioned or `/proc` path to the sidecar's secrets. (The
task's microVM kernel is the shared substrate; a kernel exploit breaches it. Accepted.)

Alternatives considered: a **shared external gateway service** (the full 0029 shape — VM-level
separation, one credential holder for all runs) — right end-state for multi-tenant, but it's
an always-on service with idle cost and per-run scoping complexity the POC doesn't need;
**GitHub App with per-run installation tokens** — the keyless-flavored upgrade, more setup,
composes with the sidecar later (the sidecar would mint short-lived tokens instead of holding
a PAT); **egress by security group** — IP-level only, can't express "this repo, these branches".

## Decision

**Add an `egress-sidecar` container to the claude-code task: the only holder of the GitHub
credential, proxying git smart-HTTP on localhost:8081 with per-run allowlisting and a
run/*-branch push policy.** (`services/claude-code-runner/sidecar.ts` — same image, second CMD.)

- **Secret placement**: a fine-grained PAT (Contents read/write, selected repos only) at SSM
  SecureString `/agent-os/claude-code/github-token` (default key, $0 — the [0033] pattern),
  injected by ECS **into the sidecar container only**. The agent container's remote is
  `http://localhost:8081/<owner>/<repo>.git`; the sidecar injects `Authorization` upstream.
- **Capability bounds** (hold AND bound, per 0029):
  - *Repo allowlist per run*: the sidecar receives the same `RUN_ID` override as the executor
    and resolves run → agent → `AgentSpec.repo` from the registry itself; only that repo's
    paths proxy, so the PAT's blast radius is one registry-declared repo per run even if the
    PAT itself has broader rights.
  - *Push policy*: `git-receive-pack` bodies are pkt-line-parsed; only creates/updates of
    `refs/heads/run/*` pass — no default-branch writes, no deletes, no tags. Unparseable ⇒ deny.
- **Workflow**: `AgentSpec.repo` ("owner/name") declares the working repo. The shim clones
  through the sidecar onto branch `run/<id>` before the harness starts, instructs it to commit
  (not push), and pushes after exit — even after a crash, so partial work is inspectable. The
  pushed branch is annotated into the run's `output`.
- **Lifecycle**: sidecar is `essential: false` (runner exit stops the task); the runner
  `dependsOn: START` + polls `/healthz` before cloning.

**Deferred, same seam**: moving `CLAUDE_CODE_OAUTH_TOKEN` behind the sidecar via
`ANTHROPIC_BASE_URL` remapping — needs a live test of subscription auth against a remapped
base URL; until then the inference credential stays an ECS secret on the agent container
(inference-only token, lower blast radius than the PAT).

## Consequences

- A prompt-injected agent can no longer exfiltrate the git credential (it never possesses
  it) and cannot push outside `run/*` or touch other repos **regardless of what it runs** —
  the policy is in a different container, not in instructions.
- The registry is now the egress policy source: granting an agent a repo is the same PutItem
  that registers it. One more resource-model cell proven: policy-as-data, enforced at a choke
  point.
- Debt accepted: the PAT is still a long-lived static secret (GitHub App tokens are the
  upgrade); the whole task fails at start if the github-token parameter is missing (ECS
  secrets resolve up front — even for repo-less runs); receive-pack bodies are buffered (100MB
  cap) to parse the command section; the inference token is not yet behind the choke point.
