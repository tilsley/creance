# ADR-0006: AgentCore as the execution environment; k8s as the control plane

- **Status:** Accepted
- **Date:** 2026-05-23

## Context

ADR-0001/0002 had us build the untrusted-code sandbox on EKS + Karpenter + gVisor
(with a future Firecracker/`.metal` tier). Research (2026-05-23) found **AWS
Bedrock AgentCore** provides exactly that isolation as a managed service: Code
Interpreter and Browser tools run each session in a dedicated **Firecracker
microVM** (own kernel, memory, network namespace; destroyed + memory-sanitized on
session end), billed per-second with **zero idle cost**. This removes the single
biggest cost/ops driver in the design (see [isolation.md](../isolation.md)).

## Decision

Split the platform into a **control plane (k8s)** and an **execution environment
(AgentCore)**:

- **k8s (EKS in prod, k3s locally) hosts the control plane:** the agent
  orchestration loop, inference-gateway, sandbox-manager, iam-authorizer,
  telemetry-processor, and Crossplane. These are *trusted* services → normal
  `runc` pods, no gVisor.
- **The agent is the orchestration loop** (trusted, in k8s). **The sandbox is only
  the execution environment** for untrusted code → **AgentCore Code Interpreter**.
  The agent is *not* deployed into AgentCore. (AgentCore Runtime remains an option
  if we ever want AWS to host the agent process itself.)
- **`sandbox-manager` becomes an AgentCore session client** (not a K8s operator
  spawning pods): start/keep-alive/stop Code Interpreter sessions, map
  session ↔ `run_id`, reconnect after restarts, enforce compute budget (ADR-0004),
  set network mode.
- **Crossplane stays the single provisioning plane** and now also provisions
  AgentCore resources (`provider-aws-bedrockagentcore`: `CodeInterpreter`)
  alongside inference profiles, IAM, budgets.
- **Karpenter is dropped for now** (its main justification was spiky sandbox
  nodes); **kept as a future option** if control-plane scaling needs it. A small
  managed node group (or local k3s) hosts the control plane.

## Session state & persistence

- Execution-session state (filesystem, variables) persists only **within** an
  AgentCore session and is destroyed on session end. That lifecycle is part of the
  **Sandbox primitive** (sandbox-manager owns it). Crossplane provisions the named
  CodeInterpreter *config*; sessions against it are runtime.
- **Durable cross-run agent memory is a separate concern**, not one of the
  original four primitives. Out of scope for the POC; a future 5th primitive could
  back it with AgentCore Memory or S3.

## Consequences

- **+** The biggest, most specialized problem (microVM isolation) is now
  AWS-managed — no gVisor AMIs, no `.metal`, no nested-virt, no snapshot/restore.
- **+** POC cost collapses: control plane on **local k3s** (free) +
  AgentCore/Bedrock pay-per-use → **~$0 idle**. Prod = same control plane on EKS.
- **+** Smaller surface: sandbox-runtime infra removed; sandbox-manager simpler.
- **−** AWS lock-in for execution; opinionated runtimes + session limits (~8h).
- **−** Maturity: AgentCore is new; Unit 42 found a network-isolation bypass via
  the microVM MMDS endpoint → AWS enforced **MMDSv2-only** for new runtimes/tools
  as of 2026-02-14. Production-grade but young; track advisories.

## Relationship

**Supersedes [ADR-0002](0002-gvisor-as-default-untrusted-tier.md)** (gVisor).
**Supersedes in part [ADR-0001](0001-build-on-eks-karpenter.md)** (sandbox
build→buy; EKS is now the control-plane host, not the sandbox host; Karpenter
optional). The analysis in [isolation.md](../isolation.md) is retained as the
*rationale* for choosing AgentCore.
