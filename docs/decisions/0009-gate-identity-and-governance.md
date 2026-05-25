# ADR-0009: Gate (identity & governance) — port + thin local adapter, managed swap-ins

- **Status:** Accepted
- **Date:** 2026-05-25

## Context

The `gate` control answers *who/what may do what, within what budget* for every
run. It's the multi-tenancy gap: today the runtime is single-tenant and the
`POST /runs` endpoint is unauthenticated. Now that a **run is a first-class,
persisted entity** ([core/runs](../../packages/core/src/runs.ts)), identity and
budget have somewhere to attach.

**Why this is a genuinely new problem.** Traditional IAM has two principal types:
*humans* (interactive login, sessions, MFA) and *services* (a static role/key,
fixed scope). Agents are **neither** — autonomous like a service, but acting *on
behalf of a specific human, with that human's scope*, spun up per task, fanning
out to many downstream systems, and **non-deterministic** (you can't enumerate
their actions in advance to pre-grant them). The crux the industry is converging
on: **one action must carry two identities at once** — the *user* who initiated it
and the *agent* that executes it — verifiably and revocably (else, from a
downstream system's view, an agent is indistinguishable from an insider threat).
It compounds across hops (Agent A → Agent B → Service C = a delegation chain). A
NIST *AI Agent Identity & Authorization* initiative and a wave of vendor products
formed around this in 2024–2026.

### Landscape (surveyed, May 2026)

`gate` is really five sub-problems. Some are mature/general; the agent-specific
ones are young:

| Sub-problem | Mature / general | Agent-specific / emerging |
|---|---|---|
| **Caller auth + human×agent token** | OAuth 2.0 **Token Exchange (RFC 8693)** — "on-behalf-of"; `act` claims encode the chain | **Auth0 "Auth for AI Agents"**, Okta, WorkOS, Scalekit, Stytch, Ping; **MCP authorization spec**; **AWS AgentCore Identity** |
| **Downstream credential brokering** (scoped short-lived tokens for GitHub/Google/DBs) | **HashiCorp Vault** (dynamic secrets); **AWS STS / Pod Identity / IRSA** | **Auth0 Token Vault**, **AgentCore Identity** (token vault + OAuth), **Composio / Arcade.dev** (SaaS-tool OAuth) |
| **Authorization / policy** | **OPA/Rego**, **Cedar / Amazon Verified Permissions**, **OpenFGA** (Zanzibar), **Oso** | (general engines slot in) |
| **Budget / cost / quotas / metering** | k8s ResourceQuota; **AWS Budgets + Bedrock application inference profiles** (ADR-0004/0005) | **AI gateways**: **LiteLLM**, Portkey, Helicone, Kong AI Gateway, Cloudflare AI Gateway |
| **Workload identity** (the runtime *as* a workload) | **SPIFFE/SPIRE**; cloud workload identity (Pod Identity/IRSA) | — |

**There is no single off-the-shelf "agent gate."** It's an *assembly*: workload
identity → caller-auth/OBO → token vault for downstream creds → policy engine →
budget/metering. Each vendor owns a slice; the agent-native ones (Auth0 Token
Vault, AgentCore Identity) bundle a couple.

## Decision

Treat `gate` like every other building block (ADR-0003): **define the port, ship a
thin local adapter now, leave the managed platforms as documented swap-ins.** Do
not bet the POC on a fast-moving vendor.

- **`Gate` port** ([core/gate](../../packages/core/src/gate.ts)): `authenticate`
  (credential → `Principal {tenant, subject}`) + per-tenant budget
  (`checkBudget` / `recordSpend`). The two-identity model lives in `Principal`.
- **`LocalGate` adapter (thin, now):** static `GATE_TOKENS` → principals; an
  in-memory per-tenant USD budget (`GATE_BUDGET_USD`) costed from inference usage.
  Dev only — static tokens, spend lost on restart.
- **`NoopGate` (default):** open, no budget — so examples / dep-migrator are
  unaffected. The runtime opts into `LocalGate` via `GATE=local`.
- **Enforcement points:** the runtime authenticates `POST /runs` and pre-checks
  budget at submit; spend is accounted after each run from token usage. (Mid-run
  hard-stop = a refinement; `maxSteps` already bounds one run.)
- **Documented swap-ins (no code yet):** **AgentCore Identity / Auth0 Token Vault**
  for the human×agent token + downstream third-party OAuth (the natural answer to
  dep-migrator's GitHub-PR step); **Bedrock application inference profiles + AWS
  Budgets** or an **AI gateway (LiteLLM)** for spend; **Cedar / OPA** for policy;
  **scoped STS / Pod Identity** (the pattern we already practiced with Crossplane)
  for AWS-downstream creds.

## Consequences

- **+** Multi-tenancy + budget land on the `Run` with a small, swappable surface;
  no premature platform lock-in; the seams are explicit.
- **+** Closes the open `/runs` endpoint; spend is attributed per tenant.
- **−** `LocalGate` is **not** production identity — no real OBO/token vault, no
  policy engine, in-memory spend, no mid-run hard-stop. These are deliberate gaps,
  filled by the swap-ins above.
- **−** Real downstream credential brokering (the `CredentialBroker` from ADR-0007)
  is still ahead — needed before the agent can open a real PR.

## Relationship

Implements the `gate` control from [primitives.md](../primitives.md); enforces the
budgets of [ADR-0004](0004-cost-governance.md); the credential-broker half is
[ADR-0007](0007-tools-and-external-auth.md). Same ports-and-adapters discipline as
[ADR-0003](0003-ports-and-adapters.md).
