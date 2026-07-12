# ADR-0041: Machine identity — client_credentials on the same pool, tenant as a scope grant

- **Status:** Accepted — deployed and verified 2026-07-12: `svc-failure-analyst`
  authenticated via client_credentials (no browser, no human, no AWS creds on the
  caller), generated through the gateway, and the spend settled on `agent-os-budgets`
  under `tenant=teama` / `period=2026-07` — the scope grant became the attribution.
- **Date:** 2026-07-12

## Context

[0040](0040-coded-agents-services-vs-libraries.md)'s Stage 1 (external agents thinking
through the gateway) made [0038](0038-agent-onboarding-behind-the-gate.md)'s
machine-identity seam blocking: the only serverless-profile credential was the console's
Cognito **id token** — a browser flow and a ~1 h lifetime, both nonsense for a service.
The failure-analyst needs to authenticate as *itself*, indefinitely, with no human and no
AWS credentials.

### Alternatives considered

- **SigV4 / caller-is-an-AWS-principal** (the EKS/Vault pattern: present a signed
  `GetCallerIdentity`): keyless and ideal *for workloads that have an AWS identity* —
  which external agents by definition may not. Right answer later for custom-kind tasks;
  wrong first move.
- **Platform-minted API keys** (our own token table): a second credential system to
  build, rotate, and verify — hand-rolled IdP features Cognito already has.
- **A second user pool for machines**: separation without a benefit; two issuers for
  every verifier to trust.
- **Long-lived static bearer in `GATE_TOKENS`**: the dev adapter; no rotation story,
  no revocation, no issuer.

## Decision

**Machines are confidential app clients on the existing pool, authenticating via the
OAuth2 `client_credentials` grant. Tenant is a resource-server scope grant. The gate's
`AUTHN=cognito` door becomes a composite that admits both credential kinds.**

- **One issuer, two credential kinds.** Humans: id token, tenant from `custom:tenant`
  ([0032](0032-web-console-cognito.md)). Machines: access token, subject = `client_id`,
  tenant from a scope `agent-os/tenant.<t>` on the pool's resource server. Granting that
  scope to a client IS the tenant onboarding act — the machine analog of setting the
  custom attribute on a user. Cognito stamps neither `aud` nor custom claims on
  client_credentials tokens (pre-token-generation hooks don't fire), so the scope *is*
  the idiomatic place for the grant, not a workaround.
- **`CognitoM2mAuthenticator`** (core adapter): verifies signature/issuer/expiry against
  the same JWKS, requires `token_use === "access"`, fails closed on zero or multiple
  tenant scopes. **`CompositeAuthenticator`**: first candidate that recognizes the
  credential wins; UnauthorizedError means "next", any other error propagates
  (infrastructure failure ≠ bad credential). `AUTHN=cognito` now builds
  `composite(cognito-jwt, cognito-m2m)` — front door and gateway pick this up by
  redeploy, zero config change.
- **The credential is a client secret** — a static secret, and we say so plainly
  (tension with the keyless stance accepted): it is *scoped* (one client = one service =
  one tenant grant), *revocable* (delete the client), *rotatable*, and never
  platform-stored (retrieved out-of-band via `describe-user-pool-client`; the platform
  only ever sees the short-lived access tokens minted from it). The keyless graduation
  is a SigV4 authenticator for callers that DO have AWS identity — a fourth composite
  candidate when needed.
- **SDK surface** (`@agent-os/client`, per 0040): `machineLogin` (one grant) and
  `machineTokenProvider` (caching + refresh-before-expiry) — the thing that outlives the
  human path's 1 h ceiling: the grant re-runs forever, no browser, no session.
- **First subject:** `svc-failure-analyst` (AuthStack), scope `agent-os/tenant.teama`.
  The conductor opts its classifier into gateway-think with four env vars
  (`AGENT_OS_{CONSOLE_URL,GATEWAY_URL,M2M_CLIENT_ID,M2M_CLIENT_SECRET}`).

## Consequences

- A service identity works everywhere `AUTHN=cognito` does — gateway *and* front door —
  so external agents can think now and create/report runs later with the same credential.
- Cognito bills per M2M app client per month (small at our count, not zero); scope
  strings couple the pool config to the authenticator's prefix
  (`COGNITO_M2M_TENANT_SCOPE_PREFIX` overrides).
- The custom kind's run credential question (0040 Stage 2) now has a floor: worst case,
  each custom agent gets an M2M client; better, dispatch mints something run-scoped —
  still open.
- Fail-closed proofs live in `cognito-m2m-authenticator.test.ts` (wrong `token_use`,
  no/multiple tenant scopes, bad signature/issuer/expiry, composite pass-through).

## Relationship

Closes the seam [0038](0038-agent-onboarding-behind-the-gate.md) named; unblocks
[0040](0040-coded-agents-services-vs-libraries.md) Stage 1; extends
[0032](0032-web-console-cognito.md)'s pool rather than adding an issuer. One-liner:
**humans get id tokens, machines get client_credentials, and tenant is always a grant an
operator made — never a claim the caller wrote.**
