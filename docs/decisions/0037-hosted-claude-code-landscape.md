# ADR-0037: Hosted headless Claude Code — landscape, positioning, and the upgrades it surfaces

- **Status:** Proposed (validates [0033](0033-claude-code-hosted-runner.md)/[0034](0034-egress-sidecar-credential-injection.md)/[0036](0036-foreign-l1-boundary-governance.md) against the 2026 field; names the upgrade backlog + the auth posture)
- **Date:** 2026-07-05

## Context

We built a hosted headless Claude Code runner ([0033](0033-claude-code-hosted-runner.md)) with a
credential-injecting egress sidecar ([0034](0034-egress-sidecar-credential-injection.md)) and named
its governance profile ([0036](0036-foreign-l1-boundary-governance.md)) — all reasoned from first
principles, without checking what the rest of the field was doing. Before investing further it's
worth knowing: are we reinventing wheels, are we secure by current standards, and is the
subscription-auth choice sound? A mid-2026 web survey (three parallel research passes) answered it.
Per our convention of putting landscape research in ADRs, the findings live here.

## Survey (mid-2026, sourced)

**Hosting pattern — mainstream.** Anthropic now publishes a *Hosting the Agent SDK* doc naming four
canonical patterns; our Fargate task-per-run is exactly their **"Ephemeral"** pattern (container per
task, one-shot entrypoint, torn down). Closest OSS analog: `ericvtheg/claude-code-runner` (same
POST→clone→PR shape, long-lived rather than scale-to-zero). More advanced self-hosts (`netclode`,
`ColeMurray/background-agents`) add warm pools + snapshot restore for scale-to-zero *with* fast
resume. The Agent SDK is the CLI-as-a-library (it bundles the native binary); Anthropic recommends
the SDK over shelling to the CLI for CI/production.
Refs: code.claude.com/docs/en/agent-sdk/hosting · github.com/ericvtheg/claude-code-runner · stanislas.blog/2026/02/netclode…

**Credential isolation — our sidecar is the converged standard, not exotic.** The "real secret lives
in an egress proxy, agent holds a localhost placeholder" pattern shipped independently in 2025–26 as
**GitHub's own `gh-aw-firewall` api-proxy-sidecar** (near-identical to ours — placeholder tokens +
`*_BASE_URL` remap + Squid allowlist), **Cloudflare Sandboxes** (identity-aware outbound injection),
**Microsandbox** (placeholder substitution, secret never enters the VM), and **Anthropic's own
hosted-Claude-Code git proxy** (scoped credential translated at the proxy, pushes restricted to the
working branch — conceptually identical to our git leg). Our path/ref-level bounds (`/v1`-only
inference, `run/*`-only pushes) are *tighter* than the host-allowlist norm.
Refs: github.com/github/gh-aw-firewall · blog.cloudflare.com/sandbox-auth · microsandbox.dev · anthropic.com/engineering/claude-code-sandboxing

**Isolation — ahead of the headline agents.** OpenHands and Devin run shared-kernel Docker (OpenHands
mounts the docker socket — a host-root footgun). Our Firecracker microVM-per-run (Fargate) is
strictly stronger, and stronger than Anthropic's *local* Claude Code default (OS primitives —
bubblewrap/Seatbelt, non-VM). Prompt-injection defense consensus ("lethal trifecta" / Meta's "Rule of
Two"): you can't reliably *detect* injection, so sever the exfiltration leg via allowlisted egress —
which is exactly what our sidecar does, architecturally (the agent can't leak a secret it never
holds, and can only push to `run/*`).

**Governance — run-count quotas are idiomatic.** Devin bills in ACUs + concurrent-session caps;
Cursor uses resetting rate-limits + concurrency caps — both *unit quotas, not dollar budgets*,
precisely because per-unit cost is fixed/subsidized. Our subscription case (dollar budget meaningless,
so cap runs — [0036](0036-foreign-l1-boundary-governance.md)) is the same move. Mature platforms pair
the outer quota with an *inner* per-run bound (max-turns/token/loop) so one run can't burn a quota's
worth of compute.

**Auth-for-automation — the one caveat.** `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` IS
Anthropic's documented CI/headless path (Pro/Max/Team/Enterprise), and we use it *first-party* (the
genuine CLI), so we're **not** the banned category — the enforced 2026 crackdown targeted *third-party*
harnesses reusing subscription tokens. But Consumer ToS §3.7 restricts automated access "except via an
API Key," and Anthropic won't bless first-party headless-on-subscription in writing. Two live risks:
subscription usage draws from the same pool as interactive sessions, and a June 2026 billing split
(programmatic use → separate metered credit) was *paused the day it launched* but is on the roadmap.

## Decision

**Continue on the current architecture — the survey validates it — and adopt the upgrades the field
flags. Fix the auth posture explicitly.**

- **Don't rebuild.** Ephemeral task-per-run, the egress sidecar, and microVM isolation are
  at-or-ahead of the field. No pivot to a different substrate or a bought sandbox is warranted.
- **Adopt three upgrades** (specced separately, backlog below):
  1. **GitHub App installation tokens** replacing the PAT — 1-hour, minted per-run scoped to the
     run's repo, held/refreshed in the sidecar. The field's near-universal recommendation; retires
     our last long-lived *token* (the app private key remains, but tokens become ephemeral + tighter).
  2. **Per-run loop detector** inside the runner — the inner bound that pairs with the run-count
     quota so one pathological run can't burn the tenant's allowance. (We already have `--max-turns`
     + a hard timeout; loop detection is the missing signal.)
  3. **SessionStore-style resume** (optional, larger) — persist the session so a follow-up run can
     `--resume`; gated on whether we want conversational/iterative runs vs one-shot.
- **Auth posture, explicit:** subscription (`setup-token`) is fine for **single-human use — including
  a sole-contributor org** (the ToS line is *other humans' runs on your subscription*, not
  personal-vs-org). The **moment a second human's runs flow through the subscription, switch to
  Bedrock** (task-role, keyless — already the [0036](0036-foreign-l1-boundary-governance.md) dial and
  [0033](0033-claude-code-hosted-runner.md) graduation path). Keep that dial warm; watch the billing
  split for its return.

## Consequences

- We can invest in the runner without fear it's a dead-end design — it's the emerging standard, early.
- The backlog is concrete and field-justified, not speculative: GitHub App tokens (security), loop
  detector (governance, pairs with the quota), resume (UX, optional).
- The subscription-auth risk is now a documented, bounded position rather than an unexamined
  assumption: safe for the POC and a solo-contributor org, with a named trigger (second human →
  Bedrock) and a named external risk (billing-split roadmap) to watch.
- Prior art worth revisiting later if we scale: `netclode`'s warm-pool + snapshot restore (scale-to-
  zero *with* fast resume), Anthropic's `SessionStore` mirror hook (cleaner than our hand-rolled
  DynamoDB transcript writes), and `open-managed-agents` as the reference if we ever host for others.
