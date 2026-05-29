# 14. Per-tenant workload identity — assume-role + Budget Action enforcement

Date: 2026-05-29

## Status

Proposed (implements [0009](0009-gate-identity-and-governance.md), refines [0013](0013-inference-cost-enforcement.md))

## Context

Until now every tenant shares **one** cloud identity: the runtime's ambient creds
(locally the `aws-creds` Secret; on EKS the `agent-os-runtime` Pod Identity role).
The per-tenant scoped IAM policy the Composition mints (`agentos-<tenant>-bedrock`,
ADR-0013) is attached to **nothing** — there is no tenant principal to scope.

This blocks two things at once:

1. **Least-privilege isolation.** A prompt-injected or buggy agent run for tenant A
   acts with the platform's full ambient permissions, not tenant A's slice. The
   blast radius is the whole platform identity, not one tenant.
2. **The cloud-side cost backstop.** ADR-0013's third enforcement layer — an AWS
   Budgets *Action* that auto-attaches a Deny when a tenant blows its cap — has
   nowhere to attach: `APPLY_IAM_POLICY` needs a principal (role/group/user), and
   no per-tenant principal exists. So the app-layer admission gate (layers 1–2) is
   currently the *only* enforcement; there is no defense-in-depth under it.

Both are the same missing primitive: **a real per-tenant cloud principal.**

ADR-0010 already anticipated this — it names "STS assume-role for AWS" as a managed
swap-in behind the `CredentialBroker` port. This ADR realizes the *workload-identity*
half of that.

## Decision

Give each tenant a real IAM **role** and make the runtime act as it, in three steps:

1. **Principal.** The Composition provisions `agentos-<tenant>` (an IAM Role) and a
   RolePolicyAttachment binding the existing scoped Bedrock policy to it. Trust is
   delegated to the account root; the *assuming* principal (the runtime user locally
   / `agent-os-runtime` role on EKS) gates assumption via its own `sts:AssumeRole`
   permission. `roleArn` is surfaced on the claim status.
2. **Binding.** Per run, the runtime resolves the tenant's `roleArn` (from the claim,
   via the same kube read the budget source already does), assumes it via STS (keyless,
   short-lived, cached to expiry), and injects the temporary creds into a tenant-scoped
   Bedrock client (and guard). The tenant's model calls run **as the tenant**.
3. **Backstop.** A per-tenant Deny policy + an AWS Budgets `BudgetAction`
   (`APPLY_IAM_POLICY`, `AUTOMATIC`, threshold 100%) auto-attaches the Deny to
   `agentos-<tenant>` when the monthly cap is breached. Cloud-enforced, lagging
   (hours), independent of the app — true defense in depth under the runtime gate.

This is the **workload-identity** strand (the agent/tenant's downstream AWS identity).
The **human×agent OBO** strand — cryptographically binding the calling human to the
agent action, and brokering downstream non-AWS creds via a Token Vault (ADR-0009/0010)
— is a separate, later phase; the static `GATE_TOKENS` stay the authn placeholder.

## Consequences

- **Real per-tenant least privilege** at the cloud layer: a run can only do what its
  tenant's policy allows, regardless of the platform's ambient permissions.
- **Keyless** throughout — STS assume-role from the base identity; no per-tenant
  static keys (honours the keyless-auth stance).
- **Three-layer cost enforcement complete** (ADR-0013): worst-case admission (app,
  immediate) + durable monthly counter (app) + Budget Action Deny (cloud, lagging).
  The backstop now bites *real* traffic because the tenant role is actually assumed.
- **Cost:** an STS `AssumeRole` per run (mitigated by caching temp creds until near
  expiry); the base identity needs `sts:AssumeRole` on `agentos-*`; the trust policy
  is account-root-broad (the caller's IAM gates it).
- **Deferred:** OBO / Token Vault / human×agent token binding — authn remains static
  bearer tokens for now.
