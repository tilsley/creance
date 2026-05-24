# agent-os

A cloud-native, multi-tenant **agent operating system**. Agents need stateful,
isolated, spiky execution — closer to "serverless that runs untrusted code" than
to traditional microservices. `agent-os` is built on **three primitives** (capabilities the agent acts with) and
**three cross-cutting controls** (canonical model:
[`docs/primitives.md`](docs/primitives.md)). Both sit behind ports, so
implementations are swappable:

| # | Primitive | Role | Backing tech |
|---|-----------|------|--------------|
| 1 | **Inference** (think) | act | Bedrock behind an internal gateway (application inference profiles) |
| 2 | **Sandbox** (do) | act | AWS Bedrock AgentCore — Firecracker-per-session (ADR-0006) |
| 3 | **State / Memory** (remember) | act — *deferred* | AgentCore Memory or a datastore (DynamoDB/Postgres/Redis/S3) |
| 4 | **Identity & governance** (gate) | cross-cutting | EKS Pod Identity + STS + scoped "human × agent" tokens |
| 5 | **Observability** (record) | cross-cutting | OpenTelemetry (ADOT) → OpenSearch + S3 |
| 6 | **Safety / Guardrails** (guard) | cross-cutting | Amazon Bedrock Guardrails (content filters, PII, grounding, injection) |

The agent runtime (L1) composes these; see [`docs/runtime.md`](docs/runtime.md).

## Decisions locked so far

- **Tenancy:** internal, multi-team. Soft isolation + governance (per-team
  namespaces/quotas, audit). We trust operators but **not** the code agents run.
- **Untrusted code:** yes. Sandboxes run agent-generated / third-party code, so
  isolation stronger than `runc` is required. See [`docs/isolation.md`](docs/isolation.md).
- **Build vs buy:** *sandbox* execution is **bought** (AWS Bedrock AgentCore); the
  control plane is **built** on k8s (EKS in prod, k3s locally). See ADR-0006.
- **Sandbox execution:** **AWS Bedrock AgentCore** — managed Firecracker-per-
  session. The agent loop stays in k8s; only untrusted code runs in AgentCore.
  Supersedes the gVisor-on-EKS plan. See [ADR-0006](docs/decisions/0006-agentcore-execution-environment.md).
- **Portability:** ports & adapters; K8s is the portable substrate (k3s local ↔
  EKS prod). See [ADR-0003](docs/decisions/0003-ports-and-adapters.md).
- **Cost governance:** Bedrock application inference profiles for attribution +
  gateway metering for real-time enforcement.
  See [ADR-0004](docs/decisions/0004-cost-governance.md).
- **Provisioning control plane:** **Crossplane** — self-service CRDs (e.g.
  `InferenceProfile` with a cost cap), no code change per team/model.
  See [ADR-0005](docs/decisions/0005-crossplane-control-plane.md).
- **Safety:** content **guard** is a third cross-cutting control (behind a
  `ContentGuard` port; default adapter Bedrock Guardrails, swappable) — screens
  model I/O and untrusted tool output (injection defense).
  See [ADR-0008](docs/decisions/0008-guard-content-safety-primitive.md).
- **First milestone:** infra scaffolding + recorded reasoning. No running
  services, no `cdk deploy` yet.

## Repository layout

```text
agent-os/
├── docs/
│   ├── architecture.md          # refined architecture; the 4 primitives + decisions
│   ├── isolation.md             # the sandbox-isolation analysis (the hard part)
│   └── decisions/               # ADRs
├── infra/                       # AWS CDK skeleton (TypeScript, run via bun) — SHELLS ONLY
│   ├── bin/agent-os.ts
│   └── lib/*-stack.ts
├── platform/                    # Crossplane control plane: self-service CRDs
│   ├── apis/inference-profile/  # Bedrock inference + cost cap
│   └── apis/sandbox/            # AgentCore Code Interpreter config
└── services/                    # platform services — READMEs only, no code yet
    ├── inference-gateway/
    ├── sandbox-manager/
    ├── tool-gateway/
    ├── iam-authorizer/
    └── telemetry-processor/
```

## Status

**Skeleton.** Docs carry the reasoning; `infra/` stacks are comment-only shells;
`services/` are READMEs describing intended responsibility. Nothing deploys yet.

## Tooling

This repo uses **bun** (not npm/node) for JS/TS. CDK runs via `bunx cdk`.
