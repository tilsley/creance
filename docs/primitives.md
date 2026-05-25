# Primitives & controls: the layered model

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
- **Component:** `inference-gateway`. Also the enforcement point for cost caps.
- **Status:** in design. See [ADR-0004](decisions/0004-cost-governance.md).

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

### 3. State / Memory — *remember*  · port `RunStore` (→ `StateStore`)
Durable, possibly shared state across runs and across agents — long-term memory.
- **Why a primitive:** can't be built on the others. Not inference (stateless),
  not sandbox (ephemeral by design), not a control. It needs its own backing store.
- **First use — run state (`RunStore`):** the L1 runtime persists each run
  (status + conversation) here, per turn. That's what makes runs **async**
  (submit → poll) and **durable** (inspectable mid-flight; recoverable with a
  persistent adapter). See [`core/runs`](../packages/core/src/runs.ts).
- **Backing:** in-memory today (dev); DynamoDB / AgentCore Memory next — swappable
  behind the port. S3 for artifacts; a transactional DB once state is *shared*.
- **Next use — cross-run memory:** the same primitive, holding learnings/results
  across runs and agents (the original "remember" vision).
- **Status:** realized for run state; cross-run memory still ahead.

---

## Controls — cross-cutting (control plane)

Enforced *around* every action — the agent doesn't call these to make progress;
the platform applies them.

### 4. Identity & governance — *gate*  · port `Gate` (→ `CredentialBroker` / `PolicyProvider`)
Who/what may do what, with least privilege. A genuinely new problem: an agent
action carries **two identities at once** — the human who initiated it and the
agent that executes it (see [ADR-0009](decisions/0009-gate-identity-and-governance.md)).
- **First use (thin, now):** the runtime authenticates `POST /runs` → a
  `Principal {tenant, subject}`, attaches it to the `Run`, and enforces a
  per-tenant budget costed from token usage. `LocalGate` adapter (dev) →
  `NoopGate` (default open).
- **Downstream creds (`CredentialBroker`):** mints scoped, short-lived creds for a
  run's `Principal` to call external systems — applied by tools **server-side, so
  the model never sees the secret** ([ADR-0010](decisions/0010-credential-broker.md)).
  `LocalCredentialBroker` (env grants, dev) → `NoopCredentialBroker` (default deny).
- **Backing / swap-ins:** EKS Pod Identity + STS + IAM (Crossplane) for
  AWS-downstream creds; AgentCore Identity / Auth0 Token Vault for the human×agent
  token + third-party OAuth ([ADR-0007](decisions/0007-tools-and-external-auth.md));
  an AI gateway / Bedrock inference profiles + AWS Budgets for spend
  ([ADR-0004](decisions/0004-cost-governance.md)); Cedar/OPA for policy.
- **Component:** `iam-authorizer`. Still ahead: real (minted) credentials + OAuth,
  a policy engine, mid-run budget hard-stop.

### 5. Observability — *record*  · port `TelemetrySink`
Structural tracking of non-deterministic agent loops.
- **Backing:** OpenTelemetry (ADOT) → OpenSearch (traces) + S3 (raw payloads).
- **Component:** `telemetry-processor`. Spans carry `agent_id`, `run_id`,
  `tokens_spent`, `tool_calls` for step-by-step replay.

### 6. Safety / Guardrails — *guard*  · port `ContentGuard`
Is the *content* safe / allowed / grounded? (Distinct axis from `gate`:
actor-authz vs content-safety.) Applied to every `think` **and** every content
crossing a trust boundary — input, output, and untrusted ingress (tool/MCP/RAG
output → model context, the injection defense).
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

## References

- [architecture.md](architecture.md) — how primitives/controls map to AWS
- [runtime.md](runtime.md) — the L1 agent contract & invocation
- ADRs: [0003](decisions/0003-ports-and-adapters.md) (ports/adapters),
  [0004](decisions/0004-cost-governance.md) (cost),
  [0005](decisions/0005-crossplane-control-plane.md) (control plane),
  [0006](decisions/0006-agentcore-execution-environment.md) (AgentCore split),
  [0007](decisions/0007-tools-and-external-auth.md) (tools/auth),
  [0008](decisions/0008-guard-content-safety-primitive.md) (guard)
