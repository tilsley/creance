# 15. Split identity (authn) and policy (authz) into separate swappable ports

Date: 2026-05-30

## Status

Proposed (refines [0009](0009-gate-identity-and-governance.md))

## Context

ADR-0009's `Gate` bundles three concerns behind one port: **authentication**
(`authenticate(credential) → Principal`), **budget governance**
(`checkBudget`/`recordSpend`), and — implicitly — nothing else. Authorization
("may this principal do this action?") didn't exist beyond the budget check.

Two problems surfaced once we looked at how this lands in a real org:

1. **authn is the crudest part of the system.** It's a static `GATE_TOKENS` lookup
   table — opaque shared secrets, hand-maintained, matched by exact string. The
   `teamA`/`teama` case mismatch (a token tenant that didn't match the claim tenant)
   silently degraded to the fallback budget + ambient creds: a **fail-open** footgun.
2. **authn and authz are different concerns owned by different layers**, and orgs
   swap them independently. In the user's org: **Istio** (and/or Google **IAP**)
   validate the human's OIDC JWT *at the edge* and forward **verified identity
   claims**; **OPA** owns the per-service allow/deny policy. The app trusts the
   propagated identity and consults policy — it doesn't re-validate or hardcode either.

A key realization de-risks this: every edge (IAP, Istio, Cognito, Auth0) reduces to
the **same contract** — *verified identity claims arrive at the service*. And
"what may a user do" is **not** the JWT; it's a policy decision the service makes
with the claims as input. So identity and policy are two independent swap points.

Istio is too heavy to run on the local 4 GiB VM; but we don't need to *run* it to
model its role — we model the *contract* (trusted propagated claims) and simulate
the edge locally.

## Decision

Split the bundled `Gate` into three single-responsibility seams:

- **`Authenticator` (authn)** — `authenticate({credential, headers}) → Principal`.
  Adapters, all producing the same `Principal{tenant, subject, groups}`:
  - `StaticTokenAuthenticator` — today's `GATE_TOKENS` (dev/placeholder).
  - `MeshTrustAuthenticator` — **trusts edge-verified claims** from a header (a JWT
    the edge already validated, or a claims blob). Models **both Istio and IAP** —
    they share the contract. Configurable header + claim names; decodes, does **not**
    re-verify (the edge did). Locally we inject the header to simulate the edge.
  - `NoopAuthenticator` — open (`default/anonymous`), the loop-direct default.
- **`Authorizer` (authz/policy)** — `authorize(principal, action, resource) →
  {allow, reason}`. The allow/deny seam agent-os lacked. Adapters:
  - `AllowAllAuthorizer` — the stub (now).
  - `OpaAuthorizer` — query OPA over its REST API (next; the user's org model —
    OPA is light enough to run for real, unlike Istio).
- **`Gate` (budget governance)** — narrowed to `checkBudget`/`recordSpend`. The
  budget is one *specialized, quantitative* policy; it stays its own seam (the
  durable counter, ADR-0013) rather than collapsing into the generic Authorizer.

The runtime binds only to the ports. Per environment you swap the adapter:

| | authn | authz |
|---|---|---|
| user's org | `MeshTrustAuthenticator` (IAP/Istio claims) | `OpaAuthorizer` |
| standalone demo | `JwtGate`/Cognito (future) | `AllowAllAuthorizer` |
| today | `StaticTokenAuthenticator` | `AllowAllAuthorizer` |

## Consequences

- **authn and authz swap independently per stack**, with no change to the agent loop
  — the ports/adapters payoff applied to identity.
- **Models the user's Istio+IAP+OPA world without running any of it**: the
  `MeshTrustAuthenticator` consumes the trusted-claims contract both edges share;
  the OPA seam exists for a light, real local adapter next.
- **Kills the fail-open footgun**: identity comes from verified claims, not a
  hand-typed string compared with `==`.
- **The budget stays a first-class governance seam**, distinct from boolean policy.
- **Deferred:** the `OpaAuthorizer` (stubbed as `AllowAll` now) and the outbound
  OBO **Token Vault** (the downstream human×agent credential exchange — the piece
  neither Istio nor OPA covers; AgentCore Identity / Auth0 territory).
