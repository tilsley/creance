# ADR-0044: The managed GCP profile — the loop on Vertex Agent Runtime as a fourth named deployment profile

- **Status:** Accepted
- **Date:** 2026-07-18

## Context

[ADR-0042](0042-agentcore-managed-profile.md) established the shape of a managed
lean-in: **a new named deployment profile over the one contract** ([ADR-0027](0027-two-deployment-profiles.md)),
not a migration or a fourth codebase — the loop container is hosted by a managed
runtime, selected by a `DISPATCH=` branch on the seam [ADR-0031](0031-serverless-substrate-for-the-run-loop.md)
built, while the gate, the inference gateway, the front door/control plane and the
claude-code lane stay **invariant**. 0042 did this for AWS AgentCore.

The [GCP service-by-service ledger](../agent-engine-service-comparison.md) (verified
2026-07-14) established that GCP's **Gemini Enterprise Agent Platform** (GEAP — the 2026
rebrand of Vertex AI Agent Builder / Agent Engine) is the direct AgentCore analog: its
**Agent Runtime** hosts a BYOC loop container, and the same two structural absences hold
— **no pre-flight per-tenant budget admission on inference** and **no inbound event
ingestion** — so the R2 gate stays ours, which is the whole thesis.

This ADR records that the profile is not hypothetical: **phases 1–3 are built and
verified live.** It also records the one place GCP is genuinely *different* from AWS —
different enough to be the profile's main engineering content, not a footnote.

Two deliberate divergences from the AWS profiles, both cheap and both intentional:

1. **IaC is Pulumi (TypeScript), not CDK** — in `infra-gcp/`, isolated from the Bun
   workspace, GCS-backed state (`gs://creance-pulumi-state`, keyless, not Pulumi Cloud).
   The AWS side is CDK; folding both under `infra/{aws,gcp}` is a later refactor.
2. **Region `europe-west2` (London)**, mirroring the AWS primary `eu-west-2` — *not*
   `us-central1` (the ledger's earlier assumption, now closed). Agent Runtime, Firestore
   and Vertex Gemini are all confirmed there.

## Decision

**Add a fourth named deployment profile — `managed GCP` — selected by env bundle like
the other three. Same contract, same invariant shell: the gate, the inference gateway,
the router/front door and the claude-code lane are byte-identical.** The loop is "the
fourth entrypoint, same image" — `agent-engine.ts` beside `server.ts`/`task.ts`/`lambda.ts`,
selected by the `AGENT_ENTRYPOINT` indirection 0042 introduced.

Mapping the profile's rows (cross-referenced to the AgentCore column of
[0042](0042-agentcore-managed-profile.md)):

| | **Managed AgentCore (0042)** | **Managed GCP (this ADR)** | Status |
|---|---|---|---|
| Loop compute | AgentCore Runtime session | **Vertex Agent Runtime** — our loop container, per-session, `min_instances=0` (scale-to-zero) | **LIVE** |
| Dispatch | `DISPATCH=agentcore` → `InvokeAgentRuntime` | **`DISPATCH=agentengine`** → `reasoningEngines:query` `{input:{runId}}` | **LIVE** |
| Run ledger | DynamoDB (already the store) | **Firestore** (`RUN_STORE=firestore`) — *new*, because the split needs a shared store (see below) | **LIVE** |
| Inference (think) | Bedrock + in-process admission | **Vertex Gemini** (`INFERENCE_PROVIDER=vertex`, `gemini-2.5-flash`) — dependency-free REST + ADC | **LIVE** |
| Sandbox (do) | AgentCore Code Interpreter | `SANDBOX_PROVIDER=local` (GCP Sandbox BYOC is a later phase) | **open** |
| Inbound authn | Cognito JWT authorizer | **`AUTHN=gcp-oidc`** — caller's Google SA **OIDC ID token** → tenant via an SA→tenant grant; `GATE=local` gates the tenant | **LIVE** |
| Memory | `MEMORY=agentcore` | GEAP **Memory Bank** adapter (so runs surface in the Agent Engine console) | **open** |
| **Inference gateway + gate** | **invariant** | **invariant** — `server.ts`, same gate | **LIVE** |
| **Front door / control plane** | **router — invariant** (calls `InvokeAgentRuntime`) | **`server.ts` — invariant** (calls `:query`) | **LIVE** |
| **claude-code lane** | Fargate + egress sidecar — cannot lean in | **Cloud Run — cannot lean in** (same 2 vCPU / no-sidecar boundary) | boundary |
| Optimizes | idle ≈ 0 *and* ops ≈ 0 | idle ≈ 0 *and* ops ≈ 0 | — |

### The one real difference — the front door/engine split needs a *shared* run store

On AWS this was invisible: DynamoDB was *already* the run ledger and the spend store, so
`DISPATCH=agentcore` reusing it was free. On GCP the local in-process store was the
default, and `DISPATCH=agentengine` **splits a run's lifecycle across two processes** —
the front door (`server.ts`) creates the run `queued` and hands off; a *different*
managed container (`agent-engine.ts`) executes it. An in-process store cannot span them,
so this profile had to grow a durable ledger: **`FirestoreRunStore`** (Firestore REST v1,
dependency-free, no google-cloud SDK — same stance as the Vertex adapter, to keep the
shared runtime image lean; scale-to-zero, on-demand-billed → ~$0 idle).

Building it surfaced two lessons worth recording — both were *silent* run-stalls, the
worst failure mode for a dispatch seam:

- **Firestore resolves the `(default)` database by project *ID* only** — a project
  *number* 404s. The managed runtime injects `GOOGLE_CLOUD_PROJECT` as the *number*
  (Vertex tolerates it; Firestore does not), so the deploy passes an explicit
  `GCP_PROJECT`=<id>.
- **A whole-doc read-modify-write store races with itself.** The Run is stored as one
  JSON blob, so `update()` rewrites the whole document. `process-run.ts` fires per-turn
  `update({messages})` fire-and-forget while awaiting the final `update({status:completed})`;
  the messages write, having read `status=running`, lands last and reverts the terminal
  status — the run rots in `running`. DynamoDB dodges this via atomic *field-level*
  `UpdateExpression`; Firestore's full-doc PATCH does not. Fix: **serialize all mutations
  through a per-instance FIFO chain** (the run's only writer is one process). At true
  multi-writer scale this graduates to a Firestore transaction.

That the *invariant shell* provoked a GCP-specific durability requirement — and that the
requirement was satisfiable behind the existing `RunStore` port with no change to the
front door — is the clearest evidence for the profile thesis this arc produced.

### Mechanism — what actually got built

1. **`DISPATCH=agentengine`** in [`dispatch.ts`](../../services/agent-runtime/dispatch.ts):
   the front door POSTs `{input:{runId}}` to `…/reasoningEngines/{id}:query`; on a dispatch
   failure it marks the run `failed` so it can't rot in `queued`.
2. **`agent-engine.ts`** — the fourth entrypoint. The runtime hosts the loop, so it forces
   `DISPATCH=inprocess` internally and executes the handed-off `runId` against the shared
   store. (The handler must check `runId` *before* its probe-mode guard — a `{runId}`
   handoff carries no `task`, so a task-shaped probe test would otherwise swallow it.)
3. **`VertexGeminiInferenceProvider`** ([adapters/vertex-gemini-inference.ts](../../packages/core/src/adapters/vertex-gemini-inference.ts))
   — neutral↔Gemini translation incl. tool round-trips, `thinkingBudget=0`, ADC token via
   the metadata server (shared `gcp-auth.ts`).
4. **`FirestoreRunStore`** ([adapters/firestore-run-store.ts](../../packages/core/src/adapters/firestore-run-store.ts))
   — the shared ledger described above.
5. **`infra-gcp/`** (Pulumi): Artifact Registry repo, the `agent-runtime` service account,
   the Firestore `(default)` database + `roles/datastore.user`, the repo-scoped
   `artifactregistry.reader` for the Reasoning Engine service agent.
6. **`deploy/gcp-agent-engine/`**: Cloud Build (amd64 → AR, same image) + a uv deploy script
   (`container_spec`=image only; everything else steered by `env_vars`).

### Phasing — what is done, what is open

1. **Loop on Runtime** (`DISPATCH=agentengine`, probe/echo) — **✅ live 2026-07-14**;
   proved the invoke path, the authorizer, and the `{output:…}` envelope.
2. **Vertex Gemini inference** — **✅ live 2026-07-14**; a real task runs end-to-end with
   `gemini-2.5-flash`, returning `{status:completed, output, usage, costUsd}`.
3. **Front-door dispatch via shared Firestore** — **✅ live 2026-07-18** ([f9a44d3](../../));
   a real task routes `server.ts` → Firestore → engine → `completed`, proving the
   invariant front door drives the managed loop.
4. **Per-tenant identity/gate** — **✅ live 2026-07-18** ([f9a44d3+](../../)); the GCP
   analog of [0041](0041-machine-identity-cognito-m2m.md). `AUTHN=gcp-oidc`
   (`GcpOidcAuthenticator`) verifies a caller's Google-signed **OIDC ID token** against
   Google's JWKS (issuer + our audience), takes `subject` = the verified SA `email`, and
   resolves `tenant` from an external **SA→tenant grant** — ID tokens can't carry a
   Cognito-scope analog, so the binding lives outside the token (adding it IS onboarding;
   at scale it graduates to a ClaimSource/Firestore resolver). The client SDK's
   `gcpIdentityTokenProvider` is the machine counterpart (metadata-server mint, cache +
   refresh). Verified live end-to-end against the front door with `GATE=local`: granted
   identity → `202`, `tenant` stamped from the token and persisted through to engine
   execution; no/garbage token → `401`; ungranted SA → `401`; over-budget tenant → `402`.
   **4b — durable per-tenant budget across the split: ✅ live 2026-07-18.**
   `SPEND_STORE=firestore` (`FirestoreSpendStore`) is the budget twin of
   `FirestoreRunStore`: the front-door `checkBudget` admission and the engine's per-token
   `reserve`/`settle` (via the AdmissionInferenceProvider) hit ONE Firestore ledger, so a
   run's cost recorded in the engine process is visible to the front door's admission —
   the same shared-store lesson as the run store. The atomic `reserve` (add iff within
   ceiling) can't be a DynamoDB-style single conditional write (Firestore field transforms
   can't express the ceiling), so it's **optimistic concurrency**: read `updateTime` →
   PATCH with a `currentDocument` precondition → retry on conflict — the multi-writer
   analog of the run store's single-process FIFO. Verified live: run 1 admitted, its cost
   recorded by the ENGINE process to the shared ledger; accumulated spend then crossed the
   cap and the FRONT DOOR denied a later run with `402` — cross-process enforcement.
   (Smoke also proved 10 parallel `reserve`s land an exact delta with no lost updates.)
5. **Sessions / Memory Bank adapter** — so runs surface in the Agent Engine console and
   memory goes live. **open.**
6. **GCP sandbox adapter** (Sandbox BYOC / Code Execution) — so tool-calling tasks work,
   not just no-tool demos. **open.**

## Consequences

- **+** **R6 (portability) is now demonstrated across two clouds, not one** — four tested
  operating points (full-k8s, cheap AWS, managed AgentCore, managed GCP), switched by env
  bundle, no rewrite. The seam held against a *second* managed platform on its first try.
- **+** **The gate still never leans.** The two structural absences held for GEAP exactly
  as for AgentCore, so the R2 budget admission stays in our invariant shell — the profile
  thesis survives the GCP cut.
- **+** **Cost shape matches the brief**: Agent Runtime `min_instances=0` + Firestore +
  Vertex on-demand → ~$0 idle, aligned with the cost-sensitive POC.
- **+** The `RunStore` port earned its keep: a genuinely new durability requirement
  (shared external ledger) landed behind it with zero change to the front door or the loop.
- **−** **A GCP-specific durability tax**: the shared store is *new surface* this profile
  alone carries (the AWS profiles reuse DynamoDB), and its whole-doc write model needed a
  concurrency fix DynamoDB never did. Documented, not hidden.
- **−** **Two IaC tools** (CDK + Pulumi) until the `infra/{aws,gcp}` refactor — more to
  learn, more to keep coherent.
- **−** **The profile is honestly partial**: identity → tenant, coarse admission, AND
  durable cross-process per-tenant spend are live, but sandbox is still `local` and memory
  is unwired. "Managed GCP" today means *the loop is managed, the caller is identified, and
  the invariant shell (identity + budget) governs it end-to-end* — not that every row
  leaned in (Sessions/Memory Bank and the GCP sandbox remain).
- **−** **The claude-code / foreign-L1 lane stays on Cloud Run** — the same boundary as
  every profile ([0036](0036-foreign-l1-boundary-governance.md)); managed-for-metered-agents,
  said plainly.
- **−** A fourth profile to conformance-test — 0027's suite (identity → claim → reserve →
  402/admit) must run against this bundle too, or the profiles drift.

## Relationship

Extends [0027](0027-two-deployment-profiles.md) (three profiles → four, same contract) and
mirrors [0042](0042-agentcore-managed-profile.md) as its GCP sibling; consumes
[0031](0031-serverless-substrate-for-the-run-loop.md)'s dispatch seam; keeps
[0019](0019-inference-gateway.md)/[0026](0026-gateway-hot-path-authn-authz-budget.md)'s
budget gate invariant; leaves [0041](0041-machine-identity-cognito-m2m.md)'s identity
story and [0030](0030-memory-model.md)'s memory seat as named open phases. Boundary:
[0036](0036-foreign-l1-boundary-governance.md) (the lane that can't lean in). Evidence:
[agent-engine-service-comparison.md](../agent-engine-service-comparison.md) (the ledger this
ADR closes) · [`deploy/gcp-agent-engine/README.md`](../../deploy/gcp-agent-engine/README.md).

One-liner: **four profiles, one contract — the second cloud proved the seam, and the
gate still never leans; GCP's only real surprise was that a split front door needs a
shared ledger, and the port absorbed it.**
