# ADR-0010: CredentialBroker — thin local broker + authenticated tool (implements ADR-0007)

- **Status:** Accepted
- **Date:** 2026-05-25

## Context

[ADR-0007](0007-tools-and-external-auth.md) decided that external-service auth is
a `gate` concern served by a **credential broker / token vault** behind a
`CredentialBroker` port (AgentCore Identity / Auth0 Token Vault as the managed
backing). [ADR-0009](0009-gate-identity-and-governance.md) built the *identity +
budget* half of `gate` thin-local; this builds the *credential* half the same way.

Without it, an agent can reason and edit a workspace but **can't act on external
systems** — dep-migrator emits a diff instead of opening a PR. The hard part isn't
storing a secret; it's letting an agent *use* one without the secret leaking into
the model's context (where a prompt-injection could exfiltrate it).

## Decision

Mirror ADR-0009: **define the port, ship a thin local adapter, document managed
swap-ins.**

- **`CredentialBroker` port** ([core/credentials](../../packages/core/src/credentials.ts)):
  `issue(principal, target) → BrokeredCredential | null`. The broker is also the
  **target allowlist** — default deny.
- **`LocalCredentialBroker` (thin, now):** a per-tenant grant table from
  `CRED_BROKER_CONFIG` (JSON), issuing short-lived credentials. Dev only — static
  secrets, no real minting.
- **`NoopCredentialBroker` (default):** deny-all, so authenticated tools are inert
  until a broker is configured.
- **`http_request` tool** ([core/tools](../../packages/core/src/tools.ts)): the
  consumer that proves the broker. The model names a `target`; the platform asks
  the broker for that principal's credential and **applies it server-side**.
- **Security properties (the point):**
  - the **secret never enters the model's context** — applied inside the tool,
    only the response body is returned. Prompt-injection can't exfiltrate it.
  - **per-tenant scoping** — `teamA`'s grant is invisible to `teamB`.
  - **allowlisted endpoint** — requests only reach the grant's `baseUrl` (SSRF guard).
  - **short-lived** — `expiresAt`, checked before use.
- **Documented swap-ins (no code):** **AgentCore Identity / Auth0 Token Vault**
  (3-legged OAuth, token vault); **GitHub App installation tokens** (the
  dep-migrator PR path); **STS assume-role** for AWS-downstream (keyless — see
  [[prefer-keyless-aws-auth]]); secrets minted/rotated, never static.

## Consequences

- **+** Agents can act on external systems with scoped creds the model never sees;
  the credential half of `gate` is now real behind a stable port.
- **+** `http_request` is the seed of the tool-gateway (ADR-0007 / a future #4).
- **−** `LocalCredentialBroker` is dev only — static secrets, no OAuth/minting/
  rotation, in-memory. Production needs the managed swap-ins above.
- **−** Authenticated tools are a **security chokepoint**: tool outputs are
  untrusted (injection/exfil) — keep the allowlist tight, creds least-privilege +
  short-lived; the `guard` control still screens tool output.

## Relationship

Implements the credential-broker half of [ADR-0007](0007-tools-and-external-auth.md);
completes the `gate` control begun in [ADR-0009](0009-gate-identity-and-governance.md);
same ports-and-adapters discipline as [ADR-0003](0003-ports-and-adapters.md).
