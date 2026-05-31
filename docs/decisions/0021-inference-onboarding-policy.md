# ADR-0021: Inference onboarding is policy, not provisioning

- **Status:** Proposed (supersedes the per-tenant-provisioning assumption of [0014](0014-per-tenant-workload-identity.md)/[0005](0005-crossplane-control-plane.md); builds on [0019](0019-inference-gateway.md))
- **Date:** 2026-05-31

## Context

[ADR-0014](0014-per-tenant-workload-identity.md) gave each tenant a provisioned AWS bundle
(IAM role, inference profile, scoped policy, Budget + Budget Action) so the runtime could call
Bedrock *as the tenant*. The [inference gateway](0019-inference-gateway.md) changes the premise:
tenants never call Bedrock and hold no creds — they call the gateway, which authenticates them,
checks a claim, meters spend in its own atomic counter, and calls the model.

So the question "how does a tenant get inference?" is no longer "provision AWS." Decomposing the
old per-tenant bundle against the gateway:

- **IAM role + assume-role** — the gateway calls Bedrock with *its* identity; tenants need none.
- **Inference profile** — redundant for *control* (the gateway meters in real time); only AWS-bill chargeback.
- **Budget + Budget Action** — **moot**: there are no tenant creds to leak, so the lagging deny backstop guards nothing the gateway's counter doesn't.

A tenant needs exactly two things, **neither of which is AWS provisioning**: an **identity** the
gateway can verify (they already have one — their SA/IAM role) and a **claim** (data) granting
inference with a budget. **Onboarding becomes a policy assertion, not a provisioning job.**

## Decision

**A tenant gets inference by asserting a claim; the gateway reads it. No per-tenant AWS.**

1. **The claim is data.** `InferenceClaim { tenant, serviceAccount, model?, monthlyBudgetUsd, sessionBudgetUsd? }` —
   *"I want model X with budget Y."* The gateway reads it; nothing is provisioned in AWS.
2. **Mechanism = a CRD validated by the API server, controller-free.** OpenAPI `pattern`/`required`
   + a CEL `x-kubernetes-validations` cross-field rule (`sessionBudgetUsd <= monthlyBudgetUsd`)
   reject bad claims **at `kubectl apply`** — clean feedback, no reconciler. A controller is
   **optional**, only for `status.conditions` or namespace-aggregate quota.
   - **ConfigMap rejected**: no schema, no status → no validation and nowhere to report errors.
3. **The `ClaimSource` port** ([claims.ts](../../packages/core/src/claims.ts)) — `forServiceAccount` +
   `forTenant`. One `KubeClaimSource` reads the CRD and satisfies **both** the gate's `BudgetSource`
   (cap) and the authn `SaTenantResolver` (SA→tenant) — replacing the two separate hardcoded readers.
   A `DynamoClaimSource` + a `POST /claims` self-service API is the **non-k8s** path (co-located with
   the slice-3 spend counter in DynamoDB), so a Lambda/ECS workload isn't forced into `kubectl`.
4. **Per-tenant AWS resources become opt-in.** Keep per-tenant roles/profiles only for
   defense-in-depth (bound a gateway compromise per tenant — the [0019](0019-inference-gateway.md)
   threat-model "real safety net") or AWS-native chargeback — and even then a **platform controller**
   provisions them, **never the tenant**. Crossplane (or CDK) is retained only for the gateway's
   **one-time shared** footprint, not a per-tenant composition.

## Consequences

- **+** Onboarding is instant, self-service, declarative — no IaC PR, no AWS API calls, no provisioning latency/failure modes. The scale-of-onboarding bottleneck (per-tenant terraform) is gone.
- **+** Validation + error reporting at apply time with **no controller to run** (CEL + OpenAPI).
- **+** Provider-/platform-agnostic via the port: CRD for k8s/GitOps tenants, DB+API for arbitrary cloud workloads.
- **+** One claim reader instead of two hardcoded ones; budget cap + identity binding from a single source.
- **−** Default isolation is **logical** (the gateway's authz/counter), not IAM-enforced — a gateway bug could cross tenants. Mitigated by opt-in per-tenant roles for high-isolation tenants.
- **−** No AWS-native per-tenant chargeback unless you opt into per-tenant profiles; you rely on the gateway's metering.
- **−** A self-service budget needs a ceiling — see the deferred `InferenceAllowance`.

## Out of scope (follow-ups)
- ✅ **Namespaced claims + `InferenceAllowance`** — *built in slice 6*: the claim is Namespaced
  (tenant = namespace, RBAC-scoped so a tenant grants only its own SAs); an admin-set
  `InferenceAllowance` per namespace caps budget + allowed models; a **ValidatingAdmissionPolicy**
  enforces each claim ≤ allowance at apply time, controller-free.
- ✅ **Aggregate quota + status** — *built in slice 7*: a `claims-controller` (the agent-controller
  reconciler pattern) sums each namespace's claims vs the allowance and writes
  `status.conditions[Ready]`; the gateway honours only non-Rejected claims (VAP = instant per-object
  gate, controller = async cross-object + status). Still deferred: a **human-approval workflow**
  (`autoApproveUnderUsd` → a `Pending` state needing sign-off) — this is auto-verdict from the aggregate.
- **Per-claim model routing/enforcement** — the claim carries `model`; the gateway still uses its configured model id today.
- ✅ **`DynamoClaimSource`** — *built in slice 8*: the non-k8s read adapter (grants in a DynamoDB
  table next to the spend counter; `CLAIM_SOURCE=dynamo`), satisfying BudgetSource + SaTenantResolver
  from the same store. Still deferred: a **`POST /claims` self-service write API** (its caller-auth
  differs from the read path — the tenant can't be claim-derived when creating the first claim).

## Relationship

Supersedes the assumption in [ADR-0014](0014-per-tenant-workload-identity.md) /
[ADR-0005](0005-crossplane-control-plane.md) that a tenant requires a provisioned AWS bundle to get
inference — the [gateway](0019-inference-gateway.md) makes that bundle optional. The claim feeds the
budget of [ADR-0013](0013-inference-cost-enforcement.md) and the authn of
[ADR-0015](0015-split-authn-authz-ports.md) through one `ClaimSource`. Validated end-to-end on the
local-k3s e2e (`deploy/local/e2e/`): verified identity, gateway inference, session 402, sandboxed
agent, **and** apply-time CEL/pattern rejection of a bad claim — no controller.
