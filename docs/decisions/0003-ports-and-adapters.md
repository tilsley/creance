# ADR-0003: Ports & adapters for environment portability (local ↔ EKS)

- **Status:** Accepted
- **Date:** 2026-05-23

## Context

agent-os should stay as close to production as possible while also running
locally on a 16GB Mac, with components that can be swapped per environment.

## Decision

Adopt a **ports & adapters (hexagonal)** structure, swapped at two layers:

1. **Kubernetes is the portable substrate.** Both environments target the same
   K8s API — `k3s`/kind locally, EKS in prod. Same manifests, same
   `RuntimeClass`. Karpenter is a **prod-only add-on that is invisible to
   workloads** (node provisioning happens below the API). So the sandbox path is
   *one* K8s adapter pointed at two clusters via kubeconfig — not two code paths.

2. **Ports only for the non-Kubernetes AWS dependencies**, selected by
   `AGENT_OS_PROFILE=local|aws`:

   | Primitive / control | Port | Local adapter | AWS adapter |
   |---|---|---|---|
   | Inference (think) | `InferenceProvider` | Bedrock (remote API, callable anywhere) or Ollama for $0 | Bedrock |
   | Sandbox (do) | `SandboxProvider` | K8s adapter → k3s | AgentCore (ADR-0006) |
   | Identity (gate) | `TokenProvider`/`PolicyProvider` | local static/scoped stub | Pod Identity + STS |
   | Telemetry (record) | `TelemetrySink` | OTel → console/Jaeger; MinIO | ADOT → OpenSearch + S3 |
   | Guard (guard) | `ContentGuard` | LLM-as-judge / Presidio / Llama Guard | Bedrock Guardrails |

**One port per primitive or control; adapter count varies.** Inference is the least
polymorphic — Bedrock is a remote API reachable from a laptop, so there's no
local-vs-cloud split; one real adapter + a fake for tests.

## Local environment (16GB Mac)

- **Cluster:** k3s via `colima --kubernetes` or k3d (~0.5–1 GB) — not
  kind/minikube/Docker-Desktop k8s (~1.5–2 GB+).
- **Runtime:** colima or OrbStack over Docker Desktop (less RAM).
- **gVisor needs Linux** → on macOS it runs inside the VM. Local default
  `runtimeClass: runc` for speed; validate real gVisor in the Linux VM or the
  cloud path. RuntimeClass is a config knob.
- Running Crossplane locally: install only granular AWS providers (see ADR-0005).

## Consequences

- High fidelity at the logic + K8s + (Linux) gVisor layers; the AWS-managed-
  service layer is necessarily stubbed locally; IAM/STS and some Bedrock
  specifics can't be perfectly faked.
- Local adapters double as test fakes.

## Relationship

Complements [ADR-0005](0005-crossplane-control-plane.md): Crossplane is the
*provisioning* control plane; ports/adapters are the *runtime* abstraction.

## Open

- Confirm `colima --kubernetes` vs `k3d` for the local cluster.
