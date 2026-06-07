# ADR-0012: Agent control plane — registry (catalog) + controller (reconciler), via an Agent CRD

- **Status:** Accepted
- **Date:** 2026-05-27

## Context

The runtime hosted exactly one hand-wired agent. A platform needs to **onboard,
version, and operate many** agents declaratively. This is the **agent control
plane** — pinned in [primitives.md](../primitives.md#agent-control-plane-planned-5)
as the sibling of Crossplane (the *infra* control plane): **not** L0 (the loop never
calls it) and **not** the L1 loop (it operates on the *population* of agents). It
governs L2 and is read by L1.

The distinction that must not collapse: **the catalog (data, read by the runtime)
vs the reconciler (makes reality match the data).**

## Decision

Build both halves, behind ports + as k8s objects, same discipline as the rest.

- **`AgentSpec` + `AgentRegistry` port** ([core/agents](../../packages/core/src/agents.ts)):
  an agent is a declarative definition (`name, tenant, model, systemPrompt, tools,
  maxSteps`). `InMemoryAgentRegistry` (dev, seeded from `AGENTS_JSON`) →
  `KubeAgentRegistry` (reads **Agent custom resources**).
- **`Agent` CRD** (`agent-os.io/v1alpha1`, [charts/agent-os/crds/agents.yaml](../../charts/agent-os/crds/agents.yaml)):
  agents are first-class k8s objects — `kubectl get agents`, RBAC, printer columns.
- **`agent-registry` (catalog):** the runtime resolves `POST /runs {agent}` →
  `AgentRegistry.get` → applies the def (systemPrompt, maxSteps). Read-only path.
- **`agent-controller` (reconciler):** a minimal **operator**
  ([services/agent-controller](../../services/agent-controller)) — lists Agent CRs,
  validates, writes `.status.phase` (`Ready`/`Invalid`). Runs as its **own pod**
  (the in-process → distributed split), reusing the `agent-runtime` image with a
  different command. Level-based **resync** loop (a `watch()` is the low-latency
  upgrade).

## Consequences

- **+** Agents are declarative, versioned, `kubectl`-managed; the runtime onboards
  a new agent with zero code change. Registry/controller split keeps data vs
  reconciliation clean.
- **+** Reuses the gate `Principal`, the tool gateway, and the existing image.
  Proves the in-process → separate-service decomposition for one component.
- **−** Thin: the controller only validates + sets status (no per-agent Deployment,
  materialization, or finalizers yet); model-per-agent isn't applied yet (only
  systemPrompt + maxSteps); resync-only (no watch).
- **−** Bun + `@kubernetes/client-node` caveats (learned live): Bun's fetch can't do
  client-cert mTLS, so the *local* kubeconfig 401s — but **in-cluster ServiceAccount
  Bearer-token auth works**, which is where these run; trust the cluster CA via
  `NODE_EXTRA_CA_CERTS`.

## Relationship

Realizes the agent control plane from [primitives.md](../primitives.md); same
ports-and-adapters discipline as [ADR-0003](0003-ports-and-adapters.md); consumes
the `Principal` from [ADR-0009](0009-gate-identity-and-governance.md).
