# Architecture Decision Records

Each ADR captures one significant decision: its context, the choice, and the
consequences. Format follows Michael Nygard's template. ADRs are immutable once
**Accepted** — to change a decision, add a new ADR that supersedes the old one.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-build-on-eks-karpenter.md) | Build the sandbox layer on EKS + Karpenter | Accepted (amended by 0006) |
| [0002](0002-gvisor-as-default-untrusted-tier.md) | gVisor as the default untrusted-code tier | Superseded by 0006 |
| [0003](0003-ports-and-adapters.md) | Ports & adapters for environment portability (local ↔ EKS) | Accepted |
| [0004](0004-cost-governance.md) | Cost governance — attribution vs. enforcement | Accepted |
| [0005](0005-crossplane-control-plane.md) | Crossplane as the self-service provisioning control plane | Accepted |
| [0006](0006-agentcore-execution-environment.md) | AgentCore as execution environment; k8s as control plane | Accepted |
| [0007](0007-tools-and-external-auth.md) | Tools & external auth — AgentCore Gateway + Identity, behind ports | Accepted |
| [0008](0008-guard-content-safety-primitive.md) | Guard (content safety) is a third cross-cutting control | Accepted |
| [0009](0009-gate-identity-and-governance.md) | Gate (identity & governance) — port + thin local adapter, managed swap-ins | Accepted |
| [0010](0010-credential-broker.md) | CredentialBroker — thin local broker + authenticated tool (implements 0007) | Accepted |
| [0011](0011-tool-mcp-gateway.md) | Tool/MCP gateway — client-side ToolProvider; AgentCore Gateway as swap-in (implements 0007) | Accepted |
| [0012](0012-agent-control-plane.md) | Agent control plane — registry (catalog) + controller (reconciler) via an Agent CRD | Accepted |
