# ADR-0032: Web console behind Cognito — human identity as an authenticator adapter

- **Status:** Proposed (consumes the substrate of [0031](0031-serverless-substrate-for-the-run-loop.md); realizes the human-IdP leg of the authn port split in [0015](0015-split-authn-authz-ports.md); runs in the cheap profile of [0027](0027-two-deployment-profiles.md))
- **Date:** 2026-07-04

## Context

The platform has substrates but no human front door. Every way of running agent-os today is
driven from a terminal: `make run`, `deploy/local/run.sh`, `deploy/eks/run.sh`, or `curl`
against the serverless front door ([0031](0031-serverless-substrate-for-the-run-loop.md)).
The runtime *does* expose everything a UI needs — `POST /runs`, `GET /runs`, `GET /runs/{id}`
(per-turn persisted, so a ~1s poll reads like live watching), `GET /tenants/{t}/budget` — and
even serves a minimal inline runs dashboard at `GET /` (`server.ts`, an embedded HTML string).
But there is no hosted UI, and critically **no human identity**: every authenticator adapter
in the tree is workload-flavored (k8s TokenReview, mesh identity, static tokens, offline JWT).
The "human × agent" token of the identity model ([0009](0009-gate-identity-and-governance.md),
[0014](0014-per-tenant-workload-identity.md)) has never had a real IdP behind the human half.

Two distinct wants are tangled in "a website for agent-os":

1. **An agent console** — launch runs, watch the transcript grow, see spend. This is a
   *data-plane client* of the existing runtime API. It is substrate-agnostic (the API is
   identical on local, EKS, and serverless), but only the serverless substrate is *always
   available without being always on* — a console pointed at EKS is dead whenever the
   cluster is down, which for a cost-sensitive POC is most of the time.
2. **An operator console** — click a button to spin up/tear down the EKS stack and watch
   resources appear. This is a *control-plane-of-the-control-plane*: a ~15-minute privileged
   job (`deploy/eks/run.sh`) needing AWS credentials and Docker builds, plus read-only
   resource views. Different machinery, different risk profile (forgetting a cluster up
   costs ~$0.25–0.30/hr).

Conflating them makes the website look bigger than it is. The console is mostly glue over
existing seams; the operator surface needs new provisioner machinery.

## Decision

**Ship the agent console first: a static SPA behind a Cognito user pool, talking to the
serverless front door. Human identity enters the platform as a `cognito-jwt` adapter behind
the existing `Authenticator` port — no gate change, no new port. Defer the operator console
to its own ADR.**

| Concern | Choice | Why |
|---|---|---|
| Backend | Serverless front door ([0031](0031-serverless-substrate-for-the-run-loop.md) Function URL) | Always available, ~$0 idle. Same API as every other substrate, so the console ports for free. |
| Human IdP | **Cognito user pool** + hosted UI, authorization-code + PKCE | Managed, ~$0 at one-user scale, issues standard JWTs with a public JWKS — exactly what the offline-JWT authn path already expects. |
| Authn | New **`cognito-jwt-authenticator`** adapter, selected via the existing `AUTHN` env seam | [0015](0015-split-authn-authz-ports.md) split the port precisely so a new identity source is an adapter, not a gate rewrite. Verifies signature/`iss`/`aud`/`exp` against the pool JWKS offline; maps claims → `{ tenant, user }` principal. R1 (verified identity) holds unchanged; R2 (budget) is untouched. |
| Hosting | Static SPA on S3 + CloudFront, config (pool id, client id, front-door URL) injected from CDK outputs | Scale-to-zero-shaped like everything else in the cheap profile; no server to run. |
| Watching | **Poll `GET /runs/{id}`** (~1s), render transcript-so-far | Already the designed watch surface of [0031](0031-serverless-substrate-for-the-run-loop.md); per-turn persistence makes polling read as live. SSE stays deferred on the same grounds as 0031. |
| Operator console | **Deferred** to a future ADR | The shape is known — a provisioner job (CodeBuild running `deploy/eks/run.sh` phase-by-phase, status row in DynamoDB, UI polls: the 0031 doorman/worker/rendezvous pattern applied to infra) — but `CONFIRM=yes bash deploy/eks/run.sh up` already does the job from a terminal, so it earns an ADR only when the console proves its keep. |

### The identity flow (end to end)

```
 BROWSER                COGNITO                 FUNCTION URL / LAMBDA          DYNAMODB
   │ 1 login (hosted UI, code+PKCE) │                    │                        │
   ├───────────────────>│           │                    │                        │
   │ 2 JWT (id/access) │            │                    │                        │
   │<──────────────────┤            │                    │                        │
   │ 3 POST /runs  Authorization: Bearer <jwt>           │                        │
   ├────────────────────────────────────────────────────>│                        │
   │                    │           │  4 cognito-jwt-authenticator:               │
   │                    │           │    verify sig/iss/aud/exp vs JWKS (offline) │
   │                    │           │    claims → {tenant, user}                  │
   │                    │           │  5 authorize → checkBudget ── read budget ─>│
   │                    │           │  6 create run, dispatch RunTask ── put ────>│
   │ 7 202 {runId}      │           │                    │                        │
   │<────────────────────────────────────────────────────┤                        │
   │ 8 poll GET /runs/{id} until terminal  (transcript grows per turn)            │
```

The token that gates the website **is** the token the runtime's gate verifies — one
credential, one identity story, no session-translation layer.

### What the console shows (v1)

Run list (`GET /runs`), launch form (`POST /runs`), run detail with the growing transcript
and per-run cost (`GET /runs/{id}`), tenant budget panel (`GET /tenants/{t}/budget`). This is
the inline `GET /` dashboard grown up and moved out; the embedded HTML becomes superseded.
Span-level observability (OTel → a backend) is explicitly **not** a prerequisite — the
run-store transcript is the only deployed signal today and is sufficient for turn-level
watching.

## Consequences

- **+** First real human IdP behind the gate: the "human" in "human × agent" stops being a
  static token. R1/R2 invariants hold in the same shape across all substrates.
- **+** The console is substrate-portable by construction — point it at a local or EKS
  deployment of the same API and it works (only the authn env differs).
- **+** ~$0 idle: S3 + CloudFront + Cognito (free tier at this scale) + the already-$0
  serverless substrate.
- **−** CORS: the Function URL must answer preflights for the CloudFront origin — new
  config on the front door, and a classic source of first-deploy friction.
- **−** Tokens live in the browser (code+PKCE mitigates; no client secret in the SPA).
  Token lifetime/refresh policy becomes a real setting instead of a dev default.
- **−** A third authn adapter to maintain, and Cognito config (pool, client, callback URLs)
  joins the CDK surface.
- **−** The tenant must be derivable from the token (custom claim or group). That mapping is
  new policy — see Open.

## Relationship

Consumes the substrate and watch model of [0031](0031-serverless-substrate-for-the-run-loop.md);
realizes the human-identity leg of [0015](0015-split-authn-authz-ports.md)'s authn port;
lives in the cheap profile of [0027](0027-two-deployment-profiles.md); the principal it mints
feeds the per-tenant chain of [0014](0014-per-tenant-workload-identity.md) unchanged.
One-liner: **a static SPA behind a Cognito user pool drives the serverless substrate; human
identity arrives as a `cognito-jwt` authenticator adapter, so the website's login token is
the same verified identity the gate already enforces.**

## Open

- **Refresh:** silent refresh in the SPA vs re-login for a POC.
- **Operator console ADR:** trigger point — when terminal-driven `run.sh` stops being enough.

*Resolved in the first cut:* the adapter verifies the **id token** (it carries `aud` = the
app client id plus the custom claims; Cognito access tokens carry neither without a
pre-token-generation hook) and asserts `token_use=id` when present. **Tenant mapping** is the
`custom:tenant` claim (configurable via `COGNITO_TENANT_CLAIM`) — the single-user-POC shape;
revisit (groups / pool-per-tenant) if real multi-tenancy arrives. Selection is
`AUTHN=cognito` + `COGNITO_ISSUER` + `COGNITO_CLIENT_ID` in the existing config seam.
