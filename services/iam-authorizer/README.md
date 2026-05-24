# iam-authorizer

**Primitive 4 — identity & governance (the guardrails) · *gate* (cross-cutting).** *No code yet — responsibility spec.*

Token exchange and policy checks so agents act with least privilege.

## Responsibilities
- Mint **scoped, temporary session tokens** = (human's permissions ∩ agent's
  system limits) when an agent acts on behalf of a user.
- Bind sandboxes to scoped IAM roles via **EKS Pod Identity** (not IRSA).
- Evaluate policy for tool/resource access; emit audit records.
- **Credential broker / token vault (outbound auth):** mint/store scoped,
  short-lived third-party creds (GitHub, OAuth providers) for agents to call
  external services. `CredentialBroker` port; backed by AgentCore Identity
  ([ADR-0007](../../docs/decisions/0007-tools-and-external-auth.md)).

## Notes
- Runs Tier 0 (`runc`) — trusted platform service.
- This is governance for *internal multi-team* use: trust operators, not code.
- **Language: TBD** (Python or Go).
