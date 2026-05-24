# ADR-0005: Crossplane as the self-service provisioning control plane

- **Status:** Accepted (provider coverage verified 2026-05-23)
- **Date:** 2026-05-23

## Context

Today, onboarding a new model or team means a code change in one place (gateway /
CDK). We want **self-service with guardrails**: anyone applies a CRD and gets
inference with a max cost, scoped IAM, etc. — an Internal Developer Platform,
not a PR queue.

## Decision

Adopt **Crossplane**. Kubernetes becomes the control plane for *provisioning*
AWS resources (not just running workloads), exposed as CRDs.

- **Layering.**
  - **CDK** = day-0 foundation: VPC, EKS, install Crossplane + AWS providers +
    provider IAM.
  - **Crossplane** = day-2 per-tenant resources via XRDs/Compositions:
    `InferenceProfile`, scoped IAM, Budgets, telemetry buckets, sandbox
    namespace + quota.
- **Self-service API.** XRD group `platform.agentos.io`. A namespaced
  `InferenceProfile` claim with `spec.parameters {team, model, maxDailyCostUSD}`
  composes: a tagged **Bedrock application inference profile** + an **AWS Budget**
  + **scoped IAM** (Pod Identity), and writes the profile ARN to a connection
  secret. See `platform/apis/inference-profile/`.
- **Portability.** The same XRDs apply to local (k3s) and prod (EKS); both
  provision *real* AWS (AWS APIs are remote). Reinforces "K8s as portable control
  plane" ([ADR-0003](0003-ports-and-adapters.md)).
- **Boundary (critical).** Crossplane *provisions and reconciles* infra —
  declarative, eventually consistent, gives attribution + delayed Budget alerts.
  It does **not** enforce real-time per-request caps; the **inference-gateway**
  does ([ADR-0004](0004-cost-governance.md)). `maxDailyCostUSD` is the shared
  declarative source.

## Consequences

- **+** Self-service paved road; no per-team/model code change; GitOps-able;
  providers are swappable.
- **−** Another system to run and learn; adds memory locally → install only
  granular providers (`provider-aws-bedrock`, `-iam`, `-budgets`).
- **Verified (2026-05-23):** coverage exists in the granular Upbound providers —
  `bedrock.aws.upbound.io/v1beta1` **InferenceProfile** (application profiles via
  `modelSource.copyFrom` + `tags` for cost allocation) and
  `budgets.aws.upbound.io/v1beta2` **Budget**; IAM via `provider-aws-iam`.
  Residual caveats: cost-allocation tags take ~24h to activate before budget tag-
  filters work; daily Budgets still lag and cannot hard-stop spend → the gateway
  enforces the real-time cap (ADR-0004). `copyFrom` takes an ARN (foundation model
  or cross-region inference profile), not a bare profile id.

## Relationship

Refines [ADR-0001](0001-build-on-eks-karpenter.md) (CDK still bootstraps EKS;
Crossplane sits on top). Complements ADR-0003 and ADR-0004.
