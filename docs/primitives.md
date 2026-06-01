# Primitives & controls: the layered model

> This is the canonical **L0** model (primitives + controls). For the full top-down
> story — requirements, the L1/L2 layers, the gate decomposition, the inference
> gateway — see [`platform.md`](platform.md).

`agent-os` is three vertical layers. The bottom (L0) has **two kinds** of
foundation: **primitives** — capabilities the agent *acts with* — and
**controls** — cross-cutting concerns the platform *enforces around* every action.
The agent runtime (L1) composes them; applications (L2) build on the runtime.

```text
  L2   agents / applications              built on the runtime
  ───────────────────────────────────────────────────────────────
  L1   agent orchestration loop           "the agent" — composes the below
  ───────────────────────────────────────────────────────────────
  L0   think        do         remember   ← PRIMITIVES (capabilities the
      inference    sandbox     state          agent acts with)

       gate (identity)                     ← CONTROLS (cross-cutting; the
       record (observability)                 platform enforces them on every
       guard (content safety)                 action / content crossing)
```

## Primitives vs. controls

- **Primitives** are *capabilities the agent invokes* to make progress — think
  (inference), do (sandbox), remember (state). The agent actively *calls* them.
- **Controls** are *cross-cutting concerns enforced around every action* — gate
  (authz), record (telemetry), guard (content safety). The agent doesn't "call"
  them to get work done; the platform applies them.

Both are foundational, both are **irreducible** (can't be built from each other),
and — crucially — **both sit behind ports, so their implementations are
swappable** (see [Everything is swappable](#everything-is-swappable) and
[ADR-0003](decisions/0003-ports-and-adapters.md)). Naming something a primitive or
a control says nothing about lock-in.

The "is it a primitive?" test (irreducible / own backing / invoked directly):
- *fails* for execution-session state (just a property of the Sandbox primitive),
- *passes* for durable memory (needs its own store → the State primitive).

Primitives are **peers, not a stack** — the only vertical ordering is L0 → L1 → L2.

---

## Primitives — capabilities (data plane)

What the agent invokes to do work, each step.

### 1. Inference — *think*  · port `InferenceProvider`
Abstracts the model provider so agents never call it directly.
- **Backing:** Amazon Bedrock, via per-team **application inference profiles**
  (cost attribution) over **cross-region** profiles (throughput/access).
- **Component:** `inference-gateway` — now a **real, standalone service** and the sole
  holder of model credentials + the cost-cap enforcement point (ADR-0019).
- **Status:** built + proven on EKS/k3s. See [ADR-0004](decisions/0004-cost-governance.md),
  [ADR-0013](decisions/0013-inference-cost-enforcement.md), [ADR-0019](decisions/0019-inference-gateway.md).

### 2. Sandbox — *do*  · port `SandboxProvider`
A persistent **workspace** for untrusted, agent-generated work: run code, run
shell commands, read/write/list files — so an agent can clone a repo, edit it,
install/build (mirrors janey-ops' `WorkspacePort`).
- **Backing:** **AWS Bedrock AgentCore Code Interpreter** (Firecracker microVM per
  session, zero idle); a **local** adapter (temp dir + bash) for dev.
- **Component:** `sandbox-manager`. Intra-session fs/vars live *here*, ephemeral.
- **Note:** AgentCore egress is network-mode-gated — `git clone` from GitHub needs
  PUBLIC/VPC mode + git in the image.
- **Status:** workspace implemented + validated (local incl. real git clone, $0;
  AgentCore runCmd + file roundtrip, live). See [ADR-0006](decisions/0006-agentcore-execution-environment.md), [isolation.md](isolation.md).
- **Coding agents — backend by profile ([ADR-0022](decisions/0022-sandbox-backends-for-coding-agents.md)):**
  AgentCore Code Interpreter for tool-execution (Model A; Public/Sandbox/**VPC** network
  modes — not VPC-limited); **E2B** or **self-hosted k8s** (Kata/gVisor + NetworkPolicy)
  for a sandboxed coding-agent CLI (Model B). For arbitrary code the **egress lockdown is
  the load-bearing safety control**, not `guard`.
- **Tools (do's second face) — `ToolProvider`:** the runtime assembles each run's
  toolset from sources (built-in workspace/http + **MCP servers**), namespaced and
  governed by a per-tenant allowlist, with `CredentialBroker` creds injected. **MCP
  is the protocol** for plugging in arbitrary tools without an adapter each
  ([ADR-0011](decisions/0011-tool-mcp-gateway.md)); AgentCore Gateway is the hosted
  swap-in.

### 3. State / Memory — *remember*  · port `RunStore` (→ `StateStore`)
Durable, possibly shared state across runs and across agents — long-term memory.
- **Why a primitive:** can't be built on the others. Not inference (stateless),
  not sandbox (ephemeral by design), not a control. It needs its own backing store.
- **First use — run state (`RunStore`):** the L1 runtime persists each run
  (status + conversation) here, per turn. That's what makes runs **async**
  (submit → poll) and **durable** (inspectable mid-flight; recoverable with a
  persistent adapter). See [`core/runs`](../packages/core/src/runs.ts).
- **Backing:** in-memory today (dev); **Postgres** as the system of record (run state,
  long-term/episodic memory, **pgvector** semantic search) with **Redis** as the hot tier
  (cache, queue, locks) — not DynamoDB ([ADR-0023](decisions/0023-memory-backends-postgres-redis.md)).
  Swappable behind the port; S3 for artifacts.
- **Next use — cross-run memory:** the same primitive, holding learnings/results
  across runs and agents (the original "remember" vision).
- **Status:** realized for run state; cross-run memory still ahead.

---

## Controls — cross-cutting (control plane)

Enforced *around* every action — the agent doesn't call these to make progress;
the platform applies them.

### 4. Identity & governance — *gate*  · ports `Authenticator` · `Authorizer` · `Gate` · `CredentialBroker`
Who/what may do what, with least privilege. A genuinely new problem: an agent
action carries **two identities at once** — the human who initiated it and the
agent that executes it (see [ADR-0009](decisions/0009-gate-identity-and-governance.md)).
The gate is **not one check** — it decomposes into four factored, swappable ports
applied in order (authn → authz → budget → creds); the full flow is in
[`platform.md` §5](platform.md#5-l1--composition-the-wiring). In summary:
- **authn — verify, don't trust (`Authenticator`):** caller credential →
  `Principal {tenant, subject, groups?, token?, actors?}`. `static-token` (dev) →
  **mesh-trust** and **OIDC-SA** (a real Kubernetes `TokenReview`, ADR-0019); the
  `tenant` is resolved from a non-forgeable claim binding.
- **authz — may this actor (`Authorizer`):** allow/deny over `(principal, action,
  resource)`. `allow-all` (dev) → **OPA** (ADR-0015).
- **budget — the real hard-stop (`Gate` + `SpendStore`):** atomic, multi-scope
  `reserve`/`settle` on a conditional DynamoDB write (tenant/month + per-session);
  worst-case admission up front, breach → 402 (ADR-0013/0019).
- **downstream creds (`CredentialBroker`):** scoped, short-lived creds applied by
  tools **server-side, so the model never sees the secret**. env grants (dev) →
  **OBO token vault, RFC 8693** ([ADR-0010](decisions/0010-credential-broker.md),
  [ADR-0016](decisions/0016-obo-token-vault.md)).
- **grants come from claims, not provisioning (`ClaimSource`):** a tenant's budget +
  model are read from an `InferenceClaim` (Kube CRD or DynamoDB) rather than a
  per-tenant AWS bundle — the L2-policy layer (ADR-0021).
- **Component:** `inference-gateway` (the enforcement choke point) + the planned
  `iam-authorizer`. Still ahead: splitting `iam-authorizer` out of in-process.

### 5. Observability — *record*  · port `TelemetrySink`
Structural tracking of non-deterministic agent loops.
- **Backing:** OpenTelemetry (ADOT) → OpenSearch (traces) + S3 (raw payloads).
- **Component:** `telemetry-processor`. Spans carry `agent_id`, `run_id`,
  `tokens_spent`, `tool_calls` for step-by-step replay.

### 6. Safety / Guardrails — *guard*  · port `ContentGuard`
Is the *content* safe / allowed / grounded? (Distinct axis from `gate`:
actor-authz vs content-safety.) Applied to every `think` **and** every content
crossing a trust boundary — input, output, and untrusted ingress: tool/MCP/RAG
output **and retrieved memory** → model context (the injection defense — memory
poisoning is persistent injection, [ADR-0023](decisions/0023-memory-backends-postgres-redis.md)).
For code-ingesting agents, compose an **injection detector** and keep policy
**code-aware** ([ADR-0008](decisions/0008-guard-content-safety-primitive.md) amendment).
- **Default adapter (swappable):** Amazon Bedrock Guardrails — content filters
  (incl. Prompt Attack), denied topics, PII filters, contextual grounding;
  **ApplyGuardrail** screens any content, even non-Bedrock. Alternatives below.
- **Where:** enforced inline at `inference-gateway` (model I/O) and `tool-gateway`
  (untrusted output) — not a standalone service. Policy is a Crossplane-provisioned
  Guardrail config (future). See [ADR-0008](decisions/0008-guard-content-safety-primitive.md).
- **Not eval:** guard is in-path/mandatory; eval is out-of-band quality assessment
  (composes, not a primitive).

---

## Everything is swappable

Every primitive *and* control sits behind a **port**; the implementation is an
**adapter**, chosen by config ([ADR-0003](decisions/0003-ports-and-adapters.md)).
We default to AWS-native adapters (Bedrock, AgentCore, Bedrock Guardrails) because
they're the least-effort path for the POC ([ADR-0006](decisions/0006-agentcore-execution-environment.md)),
not because the model requires them.

Example — the `guard` control (`ContentGuard`):
- **Default:** Amazon Bedrock Guardrails.
- **Alternatives:** Llama Guard, NVIDIA NeMo Guardrails, LLM Guard (Protect AI),
  Guardrails AI, Microsoft Presidio (PII), Lakera (injection), Azure AI Content
  Safety, OpenAI Moderation, or LLM-as-judge via the gateway.
- **Compose** several behind the one port (e.g. Presidio for PII + Llama Guard for
  toxicity + a detector for injection).

Same for the rest: `record` (`TelemetrySink`) is OTel-neutral
(OpenSearch/Jaeger/Grafana/Datadog); `gate` (`PolicyProvider`) could be Pod
Identity/STS or OPA/Cedar; `think`/`do`/`remember` swap Bedrock/AgentCore/the
datastore freely.

---

## L1 — the agent orchestration loop ("the agent")

The agent *is* the loop: trusted code (a `runc` pod in k8s) that composes the
primitives **and** controls — decide → call **inference** → act on the world (run
code in the **sandbox** *or* call a tool) → read/write **state** — every step
**gated** by identity, **recorded** by observability, and content **guarded** for
safety. The agent is **not** the sandbox; the sandbox is only its execution
environment ([ADR-0006](decisions/0006-agentcore-execution-environment.md)). Full
L1 contract: [runtime.md](runtime.md).

## L2 — agents / applications

Specific agents and products built on the runtime. Out of platform scope; they
consume L0/L1.

## Agent control plane (#5, [ADR-0012](decisions/0012-agent-control-plane.md))

Lifecycle + catalog of L2 agents — the **control plane for agents**, the sibling of
Crossplane (the control plane for *infra*). **Not L0** (the loop never calls it to
make progress) and **not the L1 loop** (it operates on the *population* of agents,
not one run). It *governs* L2 and is *read by* L1. Two components, kept distinct so
the roles don't merge:

- **`agent-registry`** — the source of truth: what agents exist, their versions,
  config, owning tenant, which model/tools each needs. The L1 runtime reads it to
  resolve "this request → which agent + config". Built: `AgentRegistry` port +
  in-memory / `KubeAgentRegistry` (reads `Agent` CRs); agents are an `Agent` CRD.
- **`agent-controller`** — reconciles `Agent` CRs and writes `.status` (an operator,
  its own pod). The analogue of a k8s Deployment controller.

> Registry = declarative truth; controller = makes reality match it. Built
> registry-first, then the controller — kept as separate components.

## References

- [architecture.md](architecture.md) — how primitives/controls map to AWS
- [resource-model.md](resource-model.md) — the object/resource inventory (k8s + AWS) per piece
- [runtime.md](runtime.md) — the L1 agent contract & invocation
- ADRs: [0003](decisions/0003-ports-and-adapters.md) (ports/adapters),
  [0004](decisions/0004-cost-governance.md) (cost),
  [0005](decisions/0005-crossplane-control-plane.md) (control plane),
  [0006](decisions/0006-agentcore-execution-environment.md) (AgentCore split),
  [0007](decisions/0007-tools-and-external-auth.md) (tools/auth),
  [0008](decisions/0008-guard-content-safety-primitive.md) (guard)
