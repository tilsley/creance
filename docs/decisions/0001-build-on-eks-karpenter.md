# ADR-0001: Build the sandbox layer on EKS + Karpenter

- **Status:** Accepted — superseded in part by [ADR-0006](0006-agentcore-execution-environment.md)
- **Date:** 2026-05-23

> **Amended (2026-05-23):** the sandbox layer moved to AWS Bedrock AgentCore
> (build→buy). EKS remains, but as the **control-plane host** (platform services +
> Crossplane), not the sandbox host. Karpenter is dropped for now, kept as a
> future option. See ADR-0006.

## Context

agent-os must execute untrusted, agent-generated code for multiple internal
teams, with spiky scale-from-zero demand. Options for the execution substrate:

1. **Buy** a managed sandbox provider (E2B, Modal, Daytona, Fly Machines).
2. **Build** on our own Kubernetes (EKS) + Karpenter for just-in-time nodes.
3. **Hybrid** — buy now, keep a seam to self-host later.

Managed providers ship the agent loop fastest but trade control and AWS-native
integration (IAM, VPC, data residency, existing tooling).

## Decision

**Build on Amazon EKS + Karpenter.** We own the cluster, node provisioning, and
the isolation runtime. Karpenter provisions nodes just-in-time for unschedulable
sandbox pods and scales them to zero when idle, matching the spiky profile.

## Consequences

**Positive**
- Full control over isolation, networking, IAM, and cost levers.
- AWS-native: VPC isolation, Pod Identity, Bedrock, CloudWatch/OpenSearch.
- No per-sandbox vendor pricing; spot/Karpenter optimization is ours.

**Negative / costs**
- Significant platform engineering: custom node images, RuntimeClass setup,
  Karpenter NodePools, patching.
- Baseline cost even when idle (control plane, NAT, base nodes).
- We must solve cold-start, egress control, and observability ourselves —
  problems managed providers have already solved.

**Mitigations**
- Default to gVisor (see [ADR-0002](0002-gvisor-as-default-untrusted-tier.md)) to
  avoid the bare-metal / nested-virt burden.
- Keep the isolation runtime behind a `RuntimeClass` seam so a managed provider
  or self-hosted E2B stack could back a tier later without app changes.
