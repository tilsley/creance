# 16. On-behalf-of credentials via a token-exchange vault

Date: 2026-05-30

## Status

Proposed (realizes [0010](0010-credential-broker.md)'s named swap-in)

## Context

ADR-0010 made downstream credentials a `CredentialBroker` port and named "Auth0
Token Vault / OAuth via AgentCore Identity" as the managed swap-in. The shipped
adapter (`LocalCredentialBroker`) is the **service-account** model: the agent acts
with its *own* fixed credential for a target; the calling human is *attribution*,
not the authorization principal.

That's the right model for many cases — and deliberately simpler. But it's
insufficient when the **downstream system enforces per-user authorization** (the
agent must only do in Jira/Drive/etc. what *this user* may). Acting with a broad
service account there is a confused-deputy risk. The fix is **on-behalf-of (OBO)**:
the agent acts AS the user, using the user's downstream permissions.

A key realization (from working the Slack→Jira use case): OBO across *many* systems
is genuinely complex (identity federation + per-user tokens + consent per target),
whereas a few scoped service accounts are simple. So this is not all-or-nothing —
it's a **per-target choice**, and the `CredentialBroker` port is exactly where that
choice lives.

## Decision

Add `OboTokenVaultBroker`, a `CredentialBroker` adapter that performs **OAuth 2.0
Token Exchange (RFC 8693)**: it posts the caller's `subject_token` + the target
`audience` to a token endpoint (AgentCore Identity / Auth0 Token Vault / any OIDC
provider that supports exchange) and gets back a downstream-scoped token that

- **acts AS the user** (the `sub`), so the downstream enforces the user's perms, and
- **carries the agent identity** too (the `act` claim) — both identities auditable
  at every hop.

Supporting changes:
- `Principal` gains an optional `token` (the inbound `subject_token`);
  `MeshTrustAuthenticator` surfaces the edge-verified token there. Identity in →
  exchange material in hand.
- The **vault is the cache**: exchanged tokens are kept per `(subject, target)` and
  reused until near expiry (refresh later), so we don't re-exchange every call.
- Selected via `CRED_BROKER=vault`. The exchanged token is applied **server-side**
  by the tool (the model never sees it), identical to any brokered credential.
- **Fails closed**: no grant, no inbound token, or an exchange error → deny.

Per-target policy: a broker can hand a **service-account** token for low-risk
targets and an **OBO** token for those that enforce per-user access — in the same
agent. Pick the cheap model where it's safe; pay for OBO where it matters.

## Consequences

- **Per-user downstream authorization + dual-identity audit** — the literal
  "agent acting on behalf of alice", enforced and logged by the downstream.
- **The same tool/flow** works for both models; only the broker swaps. The
  ticket-bot demo (service account) and the obo-token-vault demo (OBO) differ by
  one line — proving the seam.
- This is also the foundation for **agent-to-agent / multi-hop**: the exchanged
  token propagates "user × agent" identity across hops, so hop N still knows who
  the human is (the A2A identity chain).
- **Deferred:** wiring a real IdP (AgentCore Identity / Auth0) instead of the mock
  exchange endpoint; refresh-token rotation; the full A2A propagation chain;
  consent flows for first-time downstream authorization.
