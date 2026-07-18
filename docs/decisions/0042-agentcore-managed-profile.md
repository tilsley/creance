# ADR-0042: The managed AgentCore profile — lean-in as a third named deployment profile

- **Status:** Accepted (deployed + verified live — phases 1–4 on 2026-07-13; per-run
  `dispatch: "agentcore"` choice verified through the production front door 2026-07-18)
- **Date:** 2026-07-12

## Context

[ADR-0027](0027-two-deployment-profiles.md) established that deployment postures are
**named env bundles over one contract**, not forks: cheap AWS-native and full-k8s, same
ports, same invariants (R1 verified identity, R2 real-time budget), different richness.
[ADR-0031](0031-serverless-substrate-for-the-run-loop.md) gave the cheap profile its
substrate (Lambda front door + Fargate task-per-run) and, critically, built the
**dispatch seam** — the loop is substrate-agnostic by construction.

The [service-by-service comparison](../agentcore-service-comparison.md) (verified
2026-07-12) and the [posture map](../agentcore-postures.md) establish that max lean-in
is buildable: most rows are adapter swaps behind existing ports, and the four things
AgentCore structurally lacks (the gate, the front door/control-plane API,
claims/two-lane governance, the foreign-L1 lane) are exactly the things the shell
already supplies in both existing profiles.

So the question is not *whether* a "full AgentCore version" can exist but *what form it
takes*. The wrong form is a migration or a fourth codebase. The right form is the one
0027 already invented: **a third named profile**, sitting beside local-k8s/EKS (full)
and Lambda+Fargate (cheap), selected the same way.

Three enablers make this cheap now, none of which existed when
[ADR-0006](0006-agentcore-execution-environment.md) said "the agent is *not* deployed
into AgentCore":

1. **The dispatch seam** (0031): adding a substrate is a `DISPATCH=` branch, proven
   twice (in-process, `RunTask`).
2. **The Cognito identity plane** ([0032](0032-web-console-cognito.md)/[0041](0041-machine-identity-cognito-m2m.md)):
   AgentCore Runtime and Gateway both take custom **JWT authorizers against any OIDC
   IdP** — the same user pool that authenticates the console and M2M callers can
   authenticate the managed surfaces. One IdP across the whole profile.
3. **AgentCore Gateway is an MCP endpoint**, and the loop already speaks MCP
   (`McpToolProvider`, [ADR-0011](0011-tool-mcp-gateway.md)) — the tools row is
   mostly configuration.

One hard boundary from [comparison §15](../agentcore-service-comparison.md): the
**foreign-L1 / claude-code lane cannot lean in** — Runtime's non-adjustable
2 vCPU/8 GB won't hold a JVM build, there is no sidecar seat (so no
credential-substitution pattern), and there is no domain-based egress control. That
lane stays Fargate in *every* profile.

## Decision

**Add a third deployment profile — `managed AgentCore` — selected by env bundle like
the other two. Same contract, same invariant shell: the gate, the inference gateway,
the router/front door, and the claude-code lane are identical across all three
profiles.**

Extending 0027's table (amended by 0028 — one Bun gateway everywhere):

| | **Cheap AWS-native** | **Full k8s** | **Managed AgentCore** |
|---|---|---|---|
| Loop compute | Fargate task-per-run | EKS pod, always-on | **AgentCore Runtime session** — *our* loop container, per-session microVM (postures rung 1, **not** Harness) |
| Dispatch | `DISPATCH=runtask` | `DISPATCH=inprocess` | **`DISPATCH=agentcore`** → async `InvokeAgentRuntime` |
| Sandbox (do) | AgentCore Code Interpreter | gVisor/Kata + egress wall | AgentCore Code Interpreter (unchanged) |
| Tools | built-in, in-process | `tool-gateway` service + OBO vault | **AgentCore Gateway** via `MCP_SERVERS` + **Identity token vault** (2LO/3LO) |
| Memory | unwired (files/vector built) | files-first + pgvector/Postgres | **`MEMORY=agentcore`** — managed strategies, per-tenant namespaces enforced by IAM condition keys |
| Inbound authn | Cognito composite (jwt + m2m) | mesh mTLS / TokenReview | Cognito — same pool, re-used as the **Runtime/Gateway JWT authorizer** |
| Authz | AllowAll (known gap) | OPA sidecar | **Cedar on the Gateway** (tools) — front-door authz seam unchanged |
| Spend store | DynamoDB | Postgres/Redis | DynamoDB (unchanged) |
| Record | OTLP → Grafana Cloud | ADOT → OpenSearch | OTLP → Grafana Cloud (optional CloudWatch dual-export to feed Evaluations) |
| **Inference gateway + gate** | **Lambda — invariant** | **k8s service — invariant** | **Lambda — invariant** |
| **Front door / control plane** | **router Lambda — invariant** | ingress → same handler | **router Lambda — invariant** (it calls `InvokeAgentRuntime`) |
| **claude-code lane** | Fargate + egress sidecar | — | **Fargate + egress sidecar — cannot lean in** |
| Optimizes | idle cost, ops simplicity | scale, per-unit cost | **idle ≈ 0 *and* ops ≈ 0**; active-CPU billing on think-wait |

### Mechanism — what actually gets built

Small by construction, because the ports were built for exactly this:

1. **`DISPATCH=agentcore`** in [`dispatch.ts`](../../services/agent-runtime/dispatch.ts)
   (~100 LOC): the router invokes the Runtime agent asynchronously with the runId in the
   payload; run state stays in DynamoDB; watch stays run-store polling (0031's stance,
   unchanged — Runtime streaming is a later upgrade, not a prerequisite).
2. **`AgentCoreMemory` adapter** (~150 LOC) behind the `MemoryAdapter` port
   ([ADR-0030](0030-memory-model.md)'s reserved managed seat): `remember` →
   `CreateEvent`, `memory_search`/`recall` → `RetrieveMemoryRecords` within
   `/tenants/{tenant}/…`; guard-screening of writes stays in the adapter. Selector:
   `MEMORY=agentcore` + `MEMORY_ID` (files/vector keep `AGENT_MEMORY_DIR`).
3. **Tools by configuration**: `MCP_SERVERS` points at the Gateway's MCP URL; caller
   auth is the Cognito M2M token (or SigV4). May need a small auth-header option on
   `McpToolProvider` — the swap 0011 pre-documented.
4. **`AgentOsAgentCoreStack`** (CDK): the Runtime resource hosting the existing
   `agent-runtime` image (same image, fourth entrypoint), Gateway + targets, Memory
   resource, Identity credential providers, optional Cedar policy engine. Cognito pool
   and DynamoDB tables are shared with the cheap profile — the stacks compose, they
   don't duplicate.
5. **Think routing**: `INFERENCE_GATEWAY_URL` injected into the Runtime environment —
   the same mechanism that governs Model B sandboxes — or direct-Bedrock with in-process
   admission, the same choice the cheap profile makes today. Either way admission runs
   where the real model call happens.

### What is invariant — restated for the third time, deliberately

The gate (atomic reserve→settle), the claims/allowance model, tenant-stamped-from-
identity, guard placement, and the run ledger are **identical in all three profiles**.
Nothing in this profile moves an enforcement point into a box we don't control — that
is what separates this decision from adopting **Harness**, which is explicitly out of
scope (their loop = the enforcement points dissolve; postures §3.1 rung 2).

### Phasing

Each step independently shippable and demonstrable, like the EKS field trip:

1. **Loop on Runtime** (`DISPATCH=agentcore`) — highest learning-per-effort; proves the
   invoke path, the authorizer, the envelope.
2. **Memory** — currently unwired on the live profile anyway, so the managed adapter is
   the cheapest route to *having* live memory at all.
3. **Gateway + Identity tools** — unlocks the 3LO OAuth owed since 0011.
4. **Cedar policies** — more tool-boundary authz than the cheap profile has ever had.

(AgentCore **Evaluations** is orthogonal — it consumes OTEL traces from any profile and
should be evaluated independently of this ADR.)

## Consequences

- **+** The build-vs-buy curve ([0024](0024-build-vs-buy-managed-agent-platforms.md))
  becomes fully rideable in *both* directions: three tested operating points, switch by
  env bundle, no rewrite. R6 (portability) is now demonstrated rather than asserted.
- **+** **Cost shape**: Runtime bills active CPU only — LLM-wait is typically free —
  where Fargate bills wall-clock for the whole run. For a loop that mostly waits on the
  model, the managed profile is plausibly *cheaper* than the cheap profile, with a
  footprint of AgentCore + two Lambdas + DynamoDB + Cognito.
- **+** The profile *raises* some guarantees over cheap: Cedar on every tool call
  (cheap runs AllowAll), IAM-enforced memory namespaces (cheap has no live memory),
  managed 3LO token custody (owed in every profile until now).
- **+** One identity plane: the same Cognito pool authenticates the console, M2M
  callers, the Runtime invoke, and the Gateway.
- **−** **Relaxes ADR-0006's hosting stance** ("the agent is not deployed into
  AgentCore") — superseded *for this profile only*; 0006's k8s-control-plane reasoning
  predates direct code deploy, session storage/EFS, and resource policies, so the
  re-evaluation is legitimate. 0006's sandbox conclusion is untouched.
- **−** Runtime's operational envelope applies to the loop: ≤8 h sessions,
  ≤2 vCPU/8 GB (fine for the loop — heavy work is in the sandbox), 100 MB payloads,
  15-min sync timeout (we use async invocation).
- **−** The claude-code / foreign-L1 lane stays Fargate in all profiles — "managed
  AgentCore" honestly means *managed for metered agents*. The profile table must say so
  to avoid over-claiming.
- **−** A third profile to conformance-test: 0027's suite (identity → claim → reserve →
  402/admit) must run against this bundle too, or the profiles drift.
- **−** More AWS-resource lock-in surface (Runtime/Gateway/Memory resources exist only
  here) — bounded by the ports: reverting is a redeploy of a different bundle, which is
  the entire point of profiles.

## Relationship

Extends [0027](0027-two-deployment-profiles.md) (two profiles → three, same contract);
consumes [0031](0031-serverless-substrate-for-the-run-loop.md)'s dispatch seam and
[0032](0032-web-console-cognito.md)/[0041](0041-machine-identity-cognito-m2m.md)'s
identity plane; realizes [0024](0024-build-vs-buy-managed-agent-platforms.md)'s
managed-as-adapter stance at profile granularity and [0011](0011-tool-mcp-gateway.md)'s
pre-documented Gateway swap; fills [0030](0030-memory-model.md)'s managed-adapter seat;
supersedes the hosting half of [0006](0006-agentcore-execution-environment.md) for this
profile. Boundaries: [0036](0036-foreign-l1-boundary-governance.md) (the lane that
can't lean in), [0039](0039-gateway-on-the-serverless-substrate.md) (the gateway the
profile routes think through). Evidence:
[agentcore-service-comparison.md](../agentcore-service-comparison.md) ·
[agentcore-postures.md](../agentcore-postures.md) §4.1/4.3 · [costs.md](../costs.md).

One-liner: **three profiles, one contract — lean-in is a bundle you select, not a
platform you migrate to; and the gate still never leans.**
