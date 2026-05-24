# ADR-0002: gVisor as the default untrusted-code tier

- **Status:** Superseded by [ADR-0006](0006-agentcore-execution-environment.md)
- **Date:** 2026-05-23

> **Superseded (2026-05-23):** untrusted code no longer runs in our cluster — it
> runs in AWS Bedrock AgentCore (managed Firecracker-per-session). This ADR is
> retained for history; the reasoning still explains *why* AgentCore.

## Context

We run untrusted, agent-generated code on EKS (see
[ADR-0001](0001-build-on-eks-karpenter.md)), so `runc`'s shared host kernel is an
unacceptable attack surface. The two viable hardening options:

- **gVisor (`runsc`)** — userspace kernel; shrinks host syscall surface; runs on
  **normal EC2 instances**; light to install; has syscall-compat gaps and I/O
  overhead.
- **Kata + Firecracker** — real microVM per pod; strongest isolation; full Linux
  compatibility; but on AWS requires **bare-metal (`.metal`)** instances because
  normal EC2 has no nested virtualization. Expensive, slow to provision, lower
  density. The cold-start/snapshot/networking engineering is a team-sized effort
  (it's the moat of E2B/Modal/Fly).

Our threat model is "agent does something destructive, or a dependency is
malicious" for *internal* teams — not a sophisticated APT hunting a VM-escape
0-day. gVisor is a large step up from `runc` and well-matched to this.

Full analysis: [`docs/isolation.md`](../isolation.md).

## Decision

Make isolation a **per-workload `RuntimeClass` tier**:

- **Tier 0 — `runc`**: trusted platform/internal services.
- **Tier 1 — `gvisor` (default)**: untrusted agent code, on normal Karpenter nodes.
- **Tier 2 — `kata`/`firecracker` (future)**: high-assurance, on a small `.metal`
  NodePool; built only if a workload truly needs VM-grade isolation. If/when we
  do, prefer self-hosting E2B's open stack or a non-AWS / GCP host over
  hand-rolling Kata-on-metal.

Independently of tier, untrusted tiers get **controlled egress** (no default
route + allowlisted proxy + NetworkPolicy) — a kernel/VM boundary stops escape,
not exfiltration.

## Consequences

**Positive**
- Sidesteps nested-virt, bare metal, and the cloud-portability problem (gVisor is
  a userspace process on any VM). This is the path Modal runs at scale.
- Light node bootstrap (binary + shim + containerd config + RuntimeClass).
- The `RuntimeClass` seam keeps Tier 2 optional, not load-bearing.

**Negative**
- gVisor's syscall-compat gaps may break some agent code; needs a fallback story.
- I/O- and syscall-heavy workloads pay overhead.
- We still own a custom AMI / bootstrap pipeline (no managed gVisor on EKS).

**Revisit if**
- A concrete workload hits gVisor compat limits or demands VM-grade isolation, or
- compliance requires hardware-enforced boundaries → promote Tier 2.
