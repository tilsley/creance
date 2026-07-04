# ADR-0031: Serverless substrate for the agent run loop — Fargate task-per-run, Lambda front door

- **Status:** Accepted — deployed + verified live 2026-07-04 (realizes the "Compute: serverless / scale-to-zero" cell of [0027](0027-two-deployment-profiles.md) for the *runtime*, reusing the ports of [0003](0003-ports-and-adapters.md))
- **Date:** 2026-06-29

## Context

[ADR-0027](0027-two-deployment-profiles.md) named two profiles and put **"Compute:
serverless / scale-to-zero"** in the cheap column — but it only specified the *gateway*
(Bun `/v1/generate`) and the *backing stores* (DynamoDB vs Postgres/Redis). The **agent run
loop itself** — `runAgent` / `runOnSession`, the L1 loop in `loop.ts` — is still deployed
only on EKS (the current chart, `feat(eks): deploy the current chart on EKS`). So the cheap
profile's compute cell is **named but unrealized for the runtime**.

That gap is the whole cost story. Hosted k8s carries **idle cost** — an always-on control
plane, a node group running 24/7, plus the supporting cast (Postgres, OTel collector,
OpenSearch, mesh) — paid whether or not an agent ever runs. This is a cost-sensitive POC that
wants on-demand spin-up and ~$0 idle.

The key realization: **this is a packaging problem, not a new-port problem.** Ports & adapters
([0003](0003-ports-and-adapters.md)) already make the loop k8s-free — every port it touches
has a non-k8s adapter today (`dynamodb-run-store`, `dynamo`/`static-claim-source`, offline
JWT / `static-token-authenticator`, `sts-tenant-credentials`, `agentcore-sandbox`). The loop
has **no hard k8s dependency**. What's missing is a *substrate*: an entrypoint that calls
`runAgent()` and the IaC around it.

## Decision

**Run the agent loop as a Fargate task-per-run, fronted by API Gateway → a router Lambda.
Reuse the existing non-k8s adapter bundle; add no ports.**

| Concern | Choice | Why |
|---|---|---|
| Entry | **Lambda Function URL → router Lambda** | Cheap, short-lived: authenticate (R1), then dispatch. Sub-second work fits Lambda perfectly. Function URL (not API Gateway) — one fewer resource, ~$0, and the app-layer gate already does auth. |
| Executor | **Fargate `RunTask` per run** | A run is a long, multi-turn loop. Lambda's **15-min hard cap** can't bound it; a container has no cap, scales to zero, and mirrors the AgentCore microVM-per-session shape already in use. |
| State | **DynamoDB on-demand** (run-store, spend, claims) | True scale-to-zero, ~$0 idle ([0027](0027-two-deployment-profiles.md) cheap-mode store; vs [0023](0023-memory-backends-postgres-redis.md)'s Postgres for full mode). The loop already persists per-turn, so a task that dies mid-run is resumable. |
| Watch | **Poll the run-store** (turn-grained) | Per-turn persistence means a ~1s poll reads like live watching; agent progress is turn-grained anyway. See "Watching" below. |

**Adapter bundle — k8s cell → serverless cell (all already in-tree):**

| Port | Full-k8s adapter | Serverless adapter |
|---|---|---|
| AgentRegistry | `kube-agent-registry` | in-memory / Dynamo |
| ClaimSource | `kube-claim-source` | `dynamo-claim-source` / `static-claim-source` |
| Authenticator | `oidc-sa` / mesh-identity | offline JWT / `static-token-authenticator` |
| SpendStore | `postgres-spend-store` | `dynamo-spend-store` |
| RunStore | in-cluster | `dynamodb-run-store` |
| Credentials | Pod Identity / IRSA | `sts-tenant-credentials` (per-tenant assume-role) |
| Sandbox | k8s / E2B | `agentcore-sandbox` (managed, pay-per-use) |

The **only genuinely new code is the two entrypoints and the dispatch seam** — no port,
interface, or loop change:
- `task.ts` — the Fargate executor: `providersFromEnv()` → `processRun(RUN_ID)` → exit.
- `lambda.ts` — the front door on Lambda as a **native Runtime API loop** (poll
  `/invocation/next`, convert the Function URL event → a Web `Request`, run the shared
  handler, POST the result). **No HTTP server and no Lambda Web Adapter**: Bun gives us
  `Request`/`Response`/`fetch`, so the loop runs the *same* `app.ts` handler `server.ts`
  serves via `Bun.serve`. The front door is byte-identical across substrates, the way
  `process-run.ts` is byte-identical across executors.
- `dispatch.ts` — the seam: `DISPATCH=inprocess` (worker in-process, full-k8s) vs
  `runtask` (`ecs:RunTask` a task-per-run). One image, three CMDs (`server`/`task`/`lambda`).

Plus the CDK (Function URL + router Lambda, Fargate task definition, roles), reusing
StateStack's tables and BedrockStack's invoke policy by name.

### Request flow (end to end)

Two lanes — the **doorman** (Lambda, ms) and the **worker** (Fargate, seconds→minutes) —
that never call each other. Their only rendezvous is the **run row in DynamoDB**: the worker
writes it per turn, the client's poll reads it. That decoupling is what lets the doorman
finish in milliseconds while the loop runs uncapped, each scaling to zero independently.

```
 CLIENT              FUNCTION URL   LAMBDA (front door)          FARGATE (executor)        DYNAMODB
   │                      │         lambda.ts→app.ts→router      task.ts→process-run       runs / budgets
 1 │ POST /runs {task}    │              │                              │                       │
   ├─────────────────────>├── invoke ───>│                              │                       │
 2 │                      │   eventToRequest → app(req)                 │                       │
 3 │                      │   authn → authz → checkBudget ────────────────── read budget ──────>│
 4 │                      │   create queued Run ─────────────────────────────── put run ───────>│
 5 │                      │   dispatch(run): ecs:RunTask (RUN_ID) ──┐    │                       │
 6 │  202 {runId,queued}  │<── result ───┤                         │    │                       │
   │<─────────────────────┤    (Lambda idle again — done in ~ms)   ▼    │                       │
   │                      │              │                  ECS launches task (cold start:      │
   │                      │              │                  pull image, boot Bun)               │
 7 │                      │              │                         └──> task.ts reads RUN_ID     │
   │                      │              │                       status=running ────────update─>│
 8 │                      │              │            loop: guard→Bedrock→tools(AgentCore),      │
   │                      │              │                  persist EACH turn ─────────update──>│
   │                      │              │            status=completed, record spend ──update──>│
   │                      │              │                  exit (task dies → $0)               │
 9 │ GET /runs/{id} (~1s) │              │                              │                       │
   ├─────────────────────>├── invoke ───>│  app → runStore.get ──────────────── read run ─────>│
   │  {status,messages,   │<── result ───┤                              │                       │
   │   output,costUsd}    │   repeat until status ∈ {completed, failed} │                       │
   │<─────────────────────┤              │                              │                       │
```

1. `POST <FrontDoorUrl>/runs` with `{"task":…}` + `Authorization: Bearer …`.
2. The Function URL invokes the Lambda; `lambda.ts`'s loop, blocked on `/invocation/next`,
   gets the event and `eventToRequest` → a Web `Request` → `app(req)` (the shared handler).
3. `POST /runs` → `authorizeAndCreate` (`router.ts`): `authenticate` (R1) → `authorize` →
   `gate.checkBudget` (R2, reads `agent-os-budgets`).
4. Create a `queued` Run → `runStore.create` (writes `agent-os-runs`).
5. `dispatch(run)` → `runTaskDispatch` (`dispatch.ts`): `ecs:RunTask` on Fargate with
   `RUN_ID` as a container override. **Returns at once — it does not await the run.**
6. `202 {runId, status:"queued"}` flows back; the Lambda is idle again in ~ms (scales to zero).
7. **Independently**, ECS runs the task: `task.ts` reads `RUN_ID`, calls `processRun(runId)`.
   (A cold start — image pull + Bun boot — sits between steps 6 and 7; the price of scale-to-zero.)
8. `process-run.ts` runs the loop, persisting **every turn** to `agent-os-runs`; on finish it
   records spend to `agent-os-budgets` and the container **exits** (no idle cost).
9. The client **polls** `GET /runs/{id}` — a quick Lambda invoke → `runStore.get`. Per-turn
   persistence makes a ~1s poll read like live watching. Repeat until a terminal status.

### Watching: poll now, SSE deferred

For a one-user learning POC, **poll `GET /runs/{id}`** off `dynamodb-run-store`. It's a point
read (single-digit ms, fractions of a cent), and because the loop persists *every turn*, each
poll returns the transcript-so-far — turn-level watching for zero new infra. Operator-level
visibility is independent of this: the loop already wraps each step in a `TelemetrySink` span.

**SSE/streaming is deliberately deferred.** It's blocked not by "serverless" but by *ephemeral
**and** directly-addressable at once* — a task-per-run has no stable front door. The clean shape
is to **decouple**: the task publishes step events to a bus (DynamoDB Streams / SNS / EventBridge)
and a thin always-on SSE front door tails it per `run-id`. That keeps the executor ephemeral but
costs a bus + subscriber. And true *token-level* streaming needs the loop to emit **sub-turn**
events (the run-store only holds committed turns) — a bigger change than the bus itself. So SSE
is a v2 earned only when token-by-token UX becomes a requirement, not before.

## Consequences

- **+** Realizes 0027's cheap-profile compute for the runtime: ~$0 idle, on-demand spin-up, pay
  only while a run executes. Same agent code as full mode.
- **+** No new ports — the substrate is packaging + IaC over existing adapters. Small, reversible.
- **+** Per-tenant IAM scoping survives via `sts-tenant-credentials` + the task role; R1 (verified
  identity) and R2 (real-time budget) — invariant across both profiles per 0027 — still hold.
- **−** A second deployment path (Fargate/Lambda IaC) to build and operate alongside the EKS chart.
- **−** Cold start on the Bun task image (container `RunTask` pull + boot) adds first-run latency;
  acceptable for a POC, a tuning target later.
- **−** No live token streaming until the deferred bus + SSE front door lands; callers poll.
- **−** Inherits 0027's cheap-mode caveat: fewer guarantees than full mode (no OPA/mesh). Be
  explicit that this is the cheap profile, not a dropped invariant.

## Relationship

Realizes the **Compute** cell of [ADR-0027](0027-two-deployment-profiles.md) for the agent
runtime; reuses the ports of [ADR-0003](0003-ports-and-adapters.md). State backed by DynamoDB
on-demand ([0027](0027-two-deployment-profiles.md), vs [0023](0023-memory-backends-postgres-redis.md)'s
Postgres for full mode); sandbox via AgentCore ([0006](0006-agentcore-execution-environment.md)/
[0022](0022-sandbox-backends-for-coding-agents.md)); identity via per-tenant assume-role
([0014](0014-per-tenant-workload-identity.md)) + offline JWT ([0027](0027-two-deployment-profiles.md)).
One-liner: **the agent loop runs as a Fargate task-per-run behind a Lambda Function URL front
door, reusing the non-k8s adapter bundle — 0027's serverless compute cell made real, watch via
run-store polling, SSE deferred.**

## Open

- Router Lambda → `RunTask` directly, or via Step Functions (retries, resumable turns)? Lean
  direct for the first cut (implemented); revisit if mid-run resume becomes load-bearing.
- `RunTask` idempotency — dedup so a retried dispatch doesn't double-spawn a run.
- Cold-start budget for the Bun front-door + task images — measure before optimizing
  (provisioned concurrency / warm pool?).

*Resolved in the first cut:* the router hands back the `run-id` synchronously (`202` + id,
`router.ts`); the front door dispatches `RunTask` directly (`dispatch.ts`).
