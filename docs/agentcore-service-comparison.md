# agent-os × AgentCore — the service-by-service ledger

> **For each AWS Bedrock AgentCore service: what it gives us for free that we hand-rolled,
> what it gives us that we don't have at all, and what it does not provide that we built.**
> This is the *service-first* cut; the *component-first* cut (lean-in vs lean-out per port)
> is [`agentcore-postures.md`](agentcore-postures.md), the money view is
> [`costs.md`](costs.md), and the decision is
> [ADR-0024](decisions/0024-build-vs-buy-managed-agent-platforms.md). AgentCore facts
> verified against live AWS docs **2026-07-12**; our side is verified against the code and
> the post-serverless ADRs ([0031](decisions/0031-serverless-substrate-for-the-run-loop.md)–[0041](decisions/0041-machine-identity-cognito-m2m.md)),
> not the older k8s framing.

**Our baseline for the comparison** — the *live* posture, not the theoretical one: Lambda
front door + Fargate task-per-run ([ADR-0031](decisions/0031-serverless-substrate-for-the-run-loop.md)),
inference-gateway as a Lambda ([ADR-0039](decisions/0039-gateway-on-the-serverless-substrate.md)),
Cognito authn human + machine ([ADR-0032](decisions/0032-web-console-cognito.md)/[0041](decisions/0041-machine-identity-cognito-m2m.md)),
AgentCore Code Interpreter as the default sandbox ([ADR-0006](decisions/0006-agentcore-execution-environment.md)),
Grafana Cloud traces ([ADR-0035](decisions/0035-record-backend-grafana-cloud.md)),
claude-code runner + egress sidecar ([ADR-0033](decisions/0033-claude-code-hosted-runner.md)/[0034](decisions/0034-egress-sidecar-credential-injection.md)),
two-lane governance ([ADR-0036](decisions/0036-foreign-l1-boundary-governance.md)).

Each service below gets three buckets:

- **Free — and we hand-rolled it.** Adopting the service would delete or idle code we wrote.
- **Free — and we have nothing.** Net-new capability; adoption is pure addition.
- **Not provided — and we built it.** Stays ours in every posture; the reason agent-os exists.

---

## TL;DR — the whole ledger in one table

| AgentCore service | Free stuff we hand-rolled | Free stuff we don't have | What it *doesn't* provide (ours) | Our counterpart · status |
|---|---|---|---|---|
| **Runtime** | session lifecycle, streaming/resume, versioned endpoints, A2A/MCP serving, JWT/SigV4 authn | S3/EFS mounts, interactive shells, AG-UI, WebSocket | budget gate on think, substrate portability | Fargate task-per-run · **LIVE** |
| **Harness** | the entire agent loop + cost caps | skills catalog, mid-session provider switch, Step Functions | per-step gate/record/guard, R2 — it calls models itself | [`loop.ts`](../packages/core/src/loop.ts) (159 LOC) · **LIVE** |
| **Code Interpreter** | (nothing — we already buy it) | — | BYO image (Model B), egress capability-bounding | `AgentCoreSandboxProvider` · **LIVE (adopted)** |
| **Browser** | — | managed browser sessions, live-view, recording | — | none (net-new) |
| **Gateway** | MCP client/pooling, cred injection, per-tenant tool policy | connectors, Web Search, Managed KB, semantic search, WAF | **inference budget admission** (explicitly unbounded without caps) | `tool-gateway` · **BUILT (k8s only)** |
| **Identity** | token vault, 2LO/3LO, OBO exchange, JWT authorizers | Secrets Manager refs, private-VPC IdPs | tenancy *stamped* from identity, per-run repo-scoped tokens, egress sidecar | 8 authn adapters + OBO broker + sidecar · **LIVE/BUILT** |
| **Memory** | event store, extraction, vector retrieval, **IAM-enforced namespaces** | episodic strategies, record streaming, metadata filters | files-first transparency, guard-on-write, the run *ledger* | files/vector memory · **BUILT** |
| **Policy** | Cedar at the tool boundary, NL authoring, decision logs | automated-reasoning validation | policy outside the Gateway; any cost dimension | OPA adapter · **BUILT (k8s)**; serverless runs AllowAll |
| **Observability** | (we bought Grafana Cloud instead) | GenAI trace UI, cross-account | — | OTLP → Grafana · **LIVE** |
| **Evaluations** | — | 16 evaluators, online/batch, user simulation — **works outside AgentCore** | — | none — named gap |
| **Optimization** | — | prompt recs, config bundles, A/B, failure insights | — | none |
| **Registry** | agent catalog + search | curation workflow, MCP-native registry | **gated onboarding** (authz + tenant stamping), claims/allowances | `POST /agents` + registry · **BUILT** |
| **Payments** | — | x402 commerce wallets | it is *not* inference budgeting | deliberately none (≠ R2) |

And the two absences that hold in **every** row, re-confirmed 2026-07-12:

1. **No inbound webhook/event ingestion anywhere in AgentCore.** Invocation is
   `InvokeAgentRuntime`/`InvokeHarness`/WebSocket behind SigV4/JWT; AWS's own pattern is
   API GW/EventBridge → Lambda → invoke. (Neither do we — designed away for now,
   [ADR-0040](decisions/0040-coded-agents-services-vs-libraries.md).)
2. **No pre-flight per-tenant budget admission on inference.** Gateway inference targets
   *route*; the docs explicitly warn that without a token-limit policy responses are
   unbounded, naming "cost amplification on shared credentials" and "noisy neighbor
   effects" — the remedy offered is caps/throttles, not reserve/settle. The R2 gate
   ([ADR-0019](decisions/0019-inference-gateway.md)/[0026](decisions/0026-gateway-hot-path-authn-authz-budget.md))
   remains unbuyable.

**Reading for the coding-agent use case?** Skip to [§15](#15-the-coding-agent-cut--the-three-questions-that-decide-our-posture)
— BYO Java containers, artifact-repo egress, secrets injection, Strands coupling, and
the 2 vCPU/8 GB ceiling, answered in one place.

---

## 1. Runtime — GA · $0.0895/vCPU-hr + $0.00945/GB-hr, active-time billing

Per-session microVM hosting your agent container (≤2 GB image) or direct code deploy
(Python/Node.js ZIP). Limits: 2 vCPU / 8 GB, 8 h session, 100 MB payload, 15-min sync
timeout, 200 TPS invoke per agent.

**Free — and we hand-rolled it:**
- *Run dispatch + lifecycle.* Our task-per-run substrate —
  [`dispatch.ts`](../services/agent-runtime/dispatch.ts) (142 LOC), `task.ts`,
  `lambda.ts`, the router Lambda — is exactly what `InvokeAgentRuntime` + session
  lifecycle does for you. Cold start, teardown, memory sanitization: managed.
- *Streaming + resume.* We watch runs by **polling DynamoDB** (SSE deliberately deferred,
  [ADR-0031](decisions/0031-serverless-substrate-for-the-run-loop.md)); Runtime streams
  natively (HTTP/2, WebSocket, 60-min streams) and resumes sessions against managed
  session storage (1 GB / 14 d, preview) or **S3/EFS mounts**.
- *`RunTask` idempotency* — an open item on our side; session semantics give it away.
- *A2A serving.* Our hand-rolled A2A surface ([`a2a.ts`](../services/agent-runtime/a2a.ts),
  125 LOC + tests, EKS-proven per [ADR-0018](decisions/0018-a2a-protocol-transport.md)) is
  a native Runtime protocol — plus MCP (stateful mode) and AG-UI, which we don't serve at all.
- *Inbound authn at the invoke.* JWT/OAuth authorizers + resource policies
  ("only invocable from our Gateway") overlap our `Authenticator` composite on the front door.
- *Versioned endpoints* — 1,000 immutable versions, 10 aliases, instant rollback. Our
  deploy story is "push a new task definition."

**Free — and we have nothing:** interactive shell sessions (10/runtime, 1-h connections),
custom header passthrough (incl. forwarding webhook signatures), VPC deployment +
PrivateLink, GovCloud.

**Not provided — and we built it:**
- The **substrate portability seam** — one image, three entrypoints, one handler
  ([`app.ts`](../services/agent-runtime/app.ts) byte-identical across Bun server / Fargate
  / Lambda). Runtime is one more entrypoint, not a replacement for the seam (R6).
- Nothing in Runtime meters or stops model spend — the loop inside it still needs the
  gate ([§ the invariant](#what-never-appears-in-any-row)).

**Adoption note:** this is [postures §3.1 rung 1](agentcore-postures.md) — our loop in
their microVM, every control surviving. The serverless substrate we built *is* a
hand-rolled approximation of Runtime (scale-to-zero, per-run isolation, zero idle); the
honest reading is that ADR-0031 re-implemented Runtime's shape on Fargate for ~400 LOC +
one CDK stack, in exchange for no session caps, no 2-vCPU ceiling, and no per-service
lock-in.

## 2. Harness — GA Jun 2026 · no separate charge (pays Runtime rates)

The managed agent **loop**: agent = config (model, prompt, tools, skills), AWS runs the
orchestration (Strands under the hood). Multi-provider (Bedrock, OpenAI, Gemini, any
LiteLLM-compatible, Bedrock Mantle) with mid-session provider switching; built-in memory;
AWS skills catalog; immutable versions; native Step Functions state.

**Free — and we hand-rolled it:**
- The loop itself — think→do→persist, iteration caps, timeouts. Ours is
  [`loop.ts`](../packages/core/src/loop.ts): **159 lines**. Harness's cost knobs
  (`maxIterations` 75, `timeoutSeconds`, `maxTokens`, `idleRuntimeSessionTimeout`,
  `maxLifetime`) map to our stuck-detector, per-turn output cap, and
  [`loop-detector.ts`](../services/claude-code-runner/loop-detector.ts).

**Free — and we have nothing:** skills catalog (Git/S3/AWS-curated), sliding-window /
summarization truncation, Step Functions visual orchestration with human-approval
wrapping, export-to-Strands-code.

**Not provided — and we built it:**
- **Everything the loop enforces.** Gate/record/guard run per-step *because the loop is
  our code*. Harness invokes model providers itself — `maxTokens` is a per-invocation
  cap, not a tenant ledger; there is no dollar accounting, no reserve/settle, no claims.
  Adopting Harness deletes 159 LOC and surrenders R2. This is
  [postures §3.1 rung 2](agentcore-postures.md): the one lean-in that *competes with*
  agent-os instead of backing it.

**The asymmetry to notice:** Harness is the service where "free" buys the least (our
counterpart is 159 LOC) and costs the most (the enforcement point).

## 3. Code Interpreter — GA · Runtime compute rates

**Already adopted.** `AgentCoreSandboxProvider`
([agentcore-sandbox.ts](../packages/core/src/adapters/agentcore-sandbox.ts)) is the
default `SANDBOX_PROVIDER`, live in the serverless task role. This row is the proof of
ADR-0024's thesis: buy the primitive, keep the port.

**Free (and consumed):** Firecracker per session, per-second active billing, zero idle,
Python + Node.js, sandbox/public/VPC network modes, 8-h extensions, custom root CAs,
S3 file transfer ≤5 GB.

**Not provided — and we built (or kept the option to):**
- **BYO container image** — Model B (agent-CLI-in-a-box,
  [ADR-0020](decisions/0020-sandbox-execution-model.md)) doesn't fit CI; our answer is the
  claude-code Fargate task + E2B adapter, or Runtime-as-box.
- **Egress as capability, not network mode.** CI's egress control is an enum; our
  claude-code path bounds egress by *capability* — the sidecar's per-run repo allowlist +
  pkt-line push policy + `/v1/*`-only inference leg
  ([ADR-0034](decisions/0034-egress-sidecar-credential-injection.md)).

**Security ledger (updated):** the BeyondTrust sandbox-mode DNS exfiltration (published
Mar 2026) was **remediated by AWS** per the Apr 2026 blog update; Unit 42's isolation
bypass drove IMDSv2/MMDSv2-only microVMs (Feb 2026); but **VPC mode without a Route 53
Resolver DNS Firewall remains exfiltratable** (verified Apr 2026), and Unit 42's "Agent
God Mode" showed the starter toolkit's account-wide IAM roles let one agent compromise
all others — a configuration failure our per-tenant role chain
([ADR-0014](decisions/0014-per-tenant-workload-identity.md)) is specifically shaped to prevent.
Treat sandbox mode as convenience; VPC mode + DNS firewall for anything sensitive.

## 4. Browser — GA · Runtime compute rates (1 vCPU / 4 GB sessions)

**No counterpart in agent-os; nothing hand-rolled; nothing displaced.** Managed browser
sessions with CDP automation (Playwright/BrowserUse/Nova Act), human-takeover live view,
S3 session recording with console replay, OS-level interactions beyond CDP, profiles,
extensions, proxies, enterprise policies, Web Bot Auth (preview). If we ever need
browser-using agents this is a lean-in-only row — a new port, pure addition.

## 5. Gateway — GA · $0.005/1k tool calls · $0.025/1k searches · $0.02/100 tools indexed/mo

Now positioned as "agents → tools, **agents, and LLMs**" — three target categories:
MCP targets (Lambda/OpenAPI/Smithy/MCP/API-GW + 1-click connectors: Jira, Slack,
Salesforce, Zendesk, Asana, Zoom…), HTTP targets (Runtime agents, A2A, passthrough with
session stickiness), and **inference targets** (Jun 2026 — unified LLM proxy, OpenAI/
Anthropic/Bedrock-Mantle connectors, model-based routing, SDKs work by changing `base_url`).

**Free — and we hand-rolled it:**
- The tool-gateway itself — [`services/tool-gateway/`](../services/tool-gateway/)
  (~551 LOC area with the providers): MCP client + connection pooling, server-side
  credential custody/injection, per-tenant tool allowlists. Built and in-cluster-proven
  ([ADR-0029](decisions/0029-governed-egress-choke-points.md)) but **not deployed on the
  serverless profile** — so today Gateway would replace code we run only in the k8s posture.
- The OAuth 2.1 half we still owe (Atlassian/Linear 3LO) — Gateway + Identity's 3LO for
  MCP targets (GA Apr 2026) is exactly it.

**Free — and we have nothing:** 1-click SaaS connectors, **Web Search** (GA Jun 2026,
$7/1k queries, zero-egress), **Managed Knowledge Base** (GA Jun 2026, 6 RAG connectors),
semantic tool search, Lambda request/response interceptors, WAF attachment (fail-close),
MCP stateful sessions, custom domains, A/B traffic splitting.

**Not provided — and we built it:**
- **Admission on the inference path.** This is the load-bearing finding, now in AWS's own
  words: without a token-limit policy on an inference target, "each request can generate
  an unbounded streaming response," with "cost amplification on shared credentials" and
  "noisy neighbor effects" as the named risks. The mitigation AWS offers is a cap.
  Our gateway does worst-case **reserve → invoke → settle** atomically per tenant/month
  and per session, with streamed pop-once settle
  ([`messages.ts`](../services/inference-gateway/messages.ts),
  [ADR-0026](decisions/0026-gateway-hot-path-authn-authz-budget.md)/[0028](decisions/0028-own-the-gateway-engine.md)).
  Caps bound one request; admission bounds a *tenant*. Gateway inference targets are a
  routing layer we could put *behind* our gate, never a replacement for it.
- **Design A** — our callers speak neutral HTTP and the gateway terminates MCP
  ([ADR-0011](decisions/0011-tool-mcp-gateway.md)); Gateway is Design B (callers speak MCP).
  Structural absence-is-denied per-tenant allowlisting stays our semantics either way
  (Cedar can express it, but the policy is ours to write).

## 6. Identity — GA · free via Runtime/Gateway ($0.01/1k token requests standalone)

Two jobs: inbound "who may invoke" (JWT authorizers against any OIDC IdP, incl. private
VPC IdPs; SigV4) and the outbound **token vault** (OAuth2 2LO/3LO providers, API keys,
payment credentials, auto-refresh, OBO exchange, BYO Secrets Manager references).

**Free — and we hand-rolled it:**
- *Inbound verification.* Our `Authenticator` family is 8 adapters inside a ~1,467 LOC
  authn+authz area — offline JWKS verification, Cognito JWT
  ([ADR-0032](decisions/0032-web-console-cognito.md), **LIVE**), Cognito M2M
  client-credentials ([ADR-0041](decisions/0041-machine-identity-cognito-m2m.md)),
  TokenReview/mesh (k8s), composite first-recognizer-wins. A JWT authorizer on
  Runtime/Gateway does the verification leg for free (we'd keep Cognito as the IdP).
- *Outbound credential custody + refresh.* `machineTokenProvider` cache/refresh in the
  SDK, broker-held bearers, and the
  [`OboTokenVaultBroker`](../packages/core/src/adapters/obo-token-vault-broker.ts)
  (RFC 8693, 96 LOC, cross-pod A2A-proven per
  [ADR-0016](decisions/0016-obo-token-vault.md)/[0017](decisions/0017-a2a-identity-propagation.md))
  — AWS shipped the managed twin (OBO exchange, Apr 2026). The vault's Secrets Manager
  references (Jun 2026) even answer the key-custody objection: rotation and KMS policy stay ours.
- *3LO user consent* — the "allow this agent on my Jira" flow ADR-0011 names as unbuilt.

**Not provided — and we built it:**
- **Tenancy stamped from verified identity, never asserted** — across runs, agent
  registration, and claims ([ADR-0038](decisions/0038-agent-onboarding-behind-the-gate.md)/[0041](decisions/0041-machine-identity-cognito-m2m.md)).
  Identity authenticates; *what tenant means and where it's derived* is our invariant.
- **Per-run, per-repo capability-scoped credentials** — GitHub App installation tokens
  minted per run (~1 h, one repo, contents+PR,
  [`github-app-token.ts`](../services/claude-code-runner/github-app-token.ts)) and the
  **egress sidecar** ([`sidecar.ts`](../services/claude-code-runner/sidecar.ts), 262 LOC)
  that keeps the agent container credential-free while parsing git pkt-lines to enforce a
  push policy (`refs/heads/run/*` only). The vault stores and refreshes credentials; it
  does not *bound what a credential can do per run*. This goes tighter than the field
  standard ([ADR-0037](decisions/0037-hosted-claude-code-landscape.md)).
- The per-tenant **STS role chain** ([ADR-0014](decisions/0014-per-tenant-workload-identity.md))
  is plain IAM — identical in both postures, no AgentCore involvement. Watch the quota if
  ever mapping tenants to workload identities (11,000/account now — raised from 1,000).

## 7. Memory — GA · $0.25/1k events · $0.75/1k LT records/mo · $0.50/1k retrievals

Short-term event store (`actorId`/`sessionId`) + async long-term extraction (semantic,
summary, preference, **episodic**, custom, self-managed — max 6 strategies/resource).

**Free — and we hand-rolled it:**
- *Vector memory end-to-end* — [`vector-memory.ts`](../packages/core/src/adapters/vector-memory.ts)
  (156 LOC) + [`bedrock-embeddings.ts`](../packages/core/src/adapters/bedrock-embeddings.ts) +
  pgvector/Aurora bootstrap (~430 LOC total with files-memory): embedding, retrieval,
  per-tenant isolation — all managed in AgentCore Memory, with retrieval as
  `RetrieveMemoryRecords` within a namespace.
- *Per-tenant isolation, upgraded:* hierarchical namespaces enforceable with **IAM
  condition keys** (`bedrock-agentcore:namespace` / `namespacePath`) — isolation by IAM
  rather than by our adapter code. No other managed memory offers this; it would
  *strengthen* R1 for the memory tier.

**Free — and we have nothing:** episodic extraction with cross-episode reflection,
structured metadata filtering (strictly consistent since May 2026), **record streaming**
(push on create/update/delete — no polling), resource policies + cross-account + CMK.

**Not provided — and we built it:**
- **Files-first transparency** — MEMORY.md you can read, diff, and git-version
  ([ADR-0030](decisions/0030-memory-model.md)); for *coding* agents the evidence still
  favors it, and 0030 already reserves the managed-adapter seat for assistant workloads.
- **Guard-at-the-write-door** — remembered notes re-enter future prompts, so writes are
  screened ([`memory-guard.test.ts`](../packages/core/src/adapters/memory-guard.test.ts)); that
  wiring lives in our adapter regardless of backend.
- **The run ledger is not memory.** `RunStore` (status/usage/`costUsd`) is governance
  data the gate writes — stays in DynamoDB/Postgres in every posture.

Status on our side: files+vector **BUILT** and e2e-proven locally, but *unwired* on the
live serverless executor (`AGENT_MEMORY_DIR` unset) — today, memory is a row where we've
hand-rolled the thing and then not deployed it, which makes the managed option cheaper
than usual to try.

## 8. Policy — GA Mar 2026 · $0.000025/authz request

Cedar policy engines attached to Gateways: every tool call intercepted pre-execution,
conditions over user identity + tool input/output parameters, NL→Cedar authoring with
automated-reasoning validation (flags over-permissive/unsatisfiable policies), CloudWatch
decision logs, Bedrock Guardrails evaluation at the gateway layer (Jun 2026).

**Free — and we hand-rolled it:** little — our `Authorizer` port is thin by design
(OPA is bought too; the [`opa-authorizer.ts`](../packages/core/src/adapters/opa-authorizer.ts)
adapter + attribute plumbing is small). The genuinely free upgrades are NL authoring with
formal validation and managed decision logging.

**Not provided — and we built it:**
- **Authorization anywhere except the Gateway.** Policy governs the tool boundary only;
  our authz decisions also gate `POST /runs`, `agent:register` (with `kind` attributes,
  [ADR-0038](decisions/0038-agent-onboarding-behind-the-gate.md)), and repo-target checks
  ([ADR-0034](decisions/0034-egress-sidecar-credential-injection.md)). OPA applies to
  every decision point; Cedar-on-Gateway to one.
- **Any cost dimension.** Cedar is allow/deny; no spend, no metering.

**Honest mirror:** the live serverless profile runs `AllowAll` (`AUTHZ` unset) — real
policy is k8s-only today ([ADR-0031](decisions/0031-serverless-substrate-for-the-run-loop.md)
consequences). Both columns have a gap on this row; ours is deployment, theirs is scope.
They compose rather than compete (OPA on our endpoints, Cedar on a managed tool gateway).

## 9. Observability — GA · no AgentCore charge (CloudWatch rates)

OTEL-compatible; CloudWatch GenAI dashboards (trace trees, trajectory diagrams),
one-click enablement per resource, cross-account monitoring, `ActiveSessionCount` metric
(July 2026 — the only platform change in the 07-03→07-12 window), &lt;10 s trace latency.

**The cheapest dial, already settled our way.** `TelemetrySink` is OTLP
([`otel-telemetry.ts`](../packages/core/src/adapters/otel-telemetry.ts)); we deliberately
bought managed trace storage — Grafana Cloud, **LIVE**
([ADR-0035](decisions/0035-record-backend-grafana-cloud.md)) with per-run console→Grafana
deep links. AgentCore Observability is a same-shaped alternative sink, not a missing
capability. Nothing hand-rolled here beyond hand-placed instrumentation points in the
loop, which any backend needs.

## 10. Evaluations — GA Mar 2026 · $0.0024/1k in + $0.012/1k out (built-ins) · batch −25%

**16 built-in evaluators** (grown from 13 at GA): session-level goal success (± ground
truth), trace-level coherence/conciseness/context-relevance/correctness (± ground
truth)/faithfulness/harmfulness/helpfulness/instruction-following/refusal/response-
relevance/stereotyping, tool-level parameter + selection accuracy. Custom LLM-judge and
Lambda evaluators; online sampling of live traffic; batch (500 sessions/job, GA Jun 2026);
LLM-backed **user simulation** (May 2026); ground-truth assertions and expected tool sequences.

**Free — and we have nothing.** The eval harness is a named gap
([architecture.md](architecture.md) "not yet production"). And **confirmed 2026-07-12:
Evaluations scores agents running anywhere** — "AgentCore runtime, AWS Lambda, Amazon
EKS, or non-AWS environments" — by consuming OTEL/OpenInference traces. Our OTLP spans
are already the required input.

**Not provided:** nothing relevant — there is no "ours" on this row to displace.

**This is the standout row:** the one AgentCore service adoptable *today* with zero
posture change, zero code displaced, and a real gap filled. (One wrinkle: our spans go to
Grafana Cloud; Evaluations reads from CloudWatch — dual-export or a pipeline choice, not
a rewrite.)

## 11. Optimization — Recs/Batch/A-B GA Jun 2026 · Failure Insights **still preview**

Trace-driven prompt/tool-description recommendations; versioned **configuration bundles**
(behavior decoupled from code, 500 TPS hot-path reads); A/B testing via Gateway traffic
split with statistical significance; Failure Insights clusters recurring failure patterns
(including silent no-error failures) across hundreds of sessions. Works with
OTEL-instrumented agents anywhere.

**Free — and we have nothing; nothing of ours displaced.** Same adoption shape as
Evaluations (trace-fed, posture-independent) except A/B, which requires Gateway in the
serving path. Correction to the postures doc: Failure Insights is *preview*, not GA.

## 12. Registry — Preview · first 5k records/mo free, then $0.40/1k

Governed catalog (5 registries/account) of agents, MCP servers, tools, skills; records
validated against protocol schemas; publisher→curator→approve/deprecate workflow with
persona-based IAM; hybrid semantic+keyword search; **MCP-native** (queryable from IDEs via
`InvokeRegistryMcp`); EventBridge notifications (outbound only); resources can live anywhere.

**Free — and we hand-rolled it:**
- The catalog itself — `DynamoAgentRegistry` + `agent-os-agents` table, the k8s Agent CRD
  + [`agent-controller`](../services/agent-controller/controller.ts)
  ([ADR-0012](decisions/0012-agent-control-plane.md)). Registry adds curation workflow
  and semantic search we don't have.

**Not provided — and we built it:**
- **Registration as a governed write.** Registry catalogs; it "does not deploy, invoke,
  or govern runtime behavior." Our `POST /agents` is authn + `agent:register` authz +
  validation + **tenant stamped from verified identity**
  ([ADR-0038](decisions/0038-agent-onboarding-behind-the-gate.md)) — the API-server-shaped
  control point, which was always the point ("the CRD was never the point").
- **Claims/allowances** — self-asserted `InferenceClaim`, per-claim default-deny model
  routing, onboarding-as-policy ([ADR-0021](decisions/0021-inference-onboarding-policy.md)).
  No equivalent anywhere in AgentCore (R5).

## 13. Payments — Preview · no AWS charge (wallet-provider fees ~$0.005/op)

x402 micropayment orchestration: Coinbase CDP + Stripe/Privy wallets (credentials as a
new Identity provider type), HTTP-402 lifecycle, x402 Bazaar (10,000+ paid endpoints via
Gateway), Browser integration for paywalled sites.

**The nuance worth recording:** `PaymentSession` *does* implement genuine
reserve/settle-shaped budgeting — `maxSpendAmount`, deduction, refund-on-failed-signing,
deny-on-exhaustion. It is the only reserve/settle machinery in AgentCore — **and it
applies only to agent→merchant commerce**, not to your own Bedrock/tenant inference
spend. Payments is what an agent *buys*; the R2 gate is what a tenant *may burn*. No
overlap with ours, deliberately ([ADR-0036](decisions/0036-foreign-l1-boundary-governance.md)
governs spend the other way — attribution + quota, not wallets).

## 14. Gateway-delivered extras — Web Search + Managed Knowledge Base (both GA Jun 2026)

Not on the 13-service list but effectively products: **Web Search** ($7/1k queries,
Amazon index + knowledge graph, zero egress) and **Managed Knowledge Base** (managed RAG:
S3/SharePoint/Confluence/Google Drive/OneDrive/web-crawler connectors, auto-sync, hybrid
search, multimodal). No counterparts in agent-os; both are pure lean-in additions, but
both require Gateway in the path.

---

## 15. The coding-agent cut — the three questions that decide our posture

The sections above are service-shaped; our workload is coding agents (Gradle builds,
test feedback, artifact-repo access). Three questions collapse the whole doc for that
use case, all verified against the API reference and quotas 2026-07-12:

**Can we bring our own container (Java toolchain)?** Not to Code Interpreter (no BYO
image, Python/Node only) — only to **Runtime**, with a hard 2 GB image limit (not
adjustable). So "AgentCore as coding sandbox" always means Runtime-as-box
([postures §4.3](agentcore-postures.md)), never CI.

**Can we restrict egress to, say, artifact repositories, and inject secrets?** Half.
- *Egress:* the only dial is network mode — public vs your VPC. VPC mode routes through
  your subnets/security groups, but SGs are IP/port-based and **AgentCore has no
  hostname/domain egress allowlisting anywhere**. "Only Artifactory + Maven Central"
  means a forward proxy or Route 53 DNS Firewall *we* run in the VPC — the load-bearing
  egress control is hand-rolled in both postures (it is exactly the Squid-door /
  [sidecar](../services/claude-code-runner/sidecar.ts) pattern,
  [ADR-0029](decisions/0029-governed-egress-choke-points.md)/[0034](decisions/0034-egress-sidecar-credential-injection.md)).
  And VPC mode *without* a DNS Firewall remains DNS-exfiltratable (Apr 2026 follow-up, §3).
- *Secrets:* `CreateAgentRuntime` accepts `environmentVariables` (50 × 5 KB) but they are
  **plaintext config — no ECS-style `valueFrom` Secrets Manager/SSM injection exists.**
  The Identity vault's model is fetch-from-inside (`GetResourceApiKey`), so the
  credential enters the agent's blast radius; our sidecar substitution (credential never
  present in the agent container) has no AgentCore equivalent.

**Do 2 vCPU / 8 GB fit a Gradle build?** No — and the quota is explicitly
**not adjustable**, for both Runtime and Code Interpreter. Disk: 10 GB (CI) / 1 GB
managed session storage + S3/EFS mounts (Runtime). A Gradle daemon + compiler + forked
test JVMs routinely exceeds 8 GB. Our Fargate task-per-run scales to **16 vCPU / 120 GB
/ 200 GB ephemeral** — for JVM coding agents the hand-rolled substrate
([ADR-0031](decisions/0031-serverless-substrate-for-the-run-loop.md)) is not a
re-implementation of Runtime, it's the only one of the two that fits the workload.

**Strands coupling (asked often, answered once):** only **Harness** is Strands-coupled
(it *is* a managed Strands loop; export-to-code exports Strands). Runtime's contract is
"any HTTP server on port 8080 at `/invocations`, any language" — the docs name LangGraph,
CrewAI, and custom agents; our Bun/TS loop qualifies unchanged. Memory, Gateway,
Identity, CI, Browser, Policy are plain AWS APIs; Evaluations consumes OTEL/OpenInference
traces, not framework objects. The Strands flavor in AWS samples is the optional Python
starter toolkit, not the services.

**Verdict for the coding-agent workload:** AgentCore's sandbox story fits *small*
tool-executor code steps (Model A — which we already buy via CI) but not
agent-CLI-in-a-box JVM work: image cap, hard 2 vCPU/8 GB ceiling, no domain egress
control, no credential substitution. The three things we hand-rolled for the claude-code
runner (big Fargate boxes, sidecar-injected repo-scoped credentials, capability-bounded
egress) are precisely the three things Runtime cannot currently do.

---

## What never appears in any row

The list the whole doc keeps converging on — built here, provided nowhere in AgentCore,
re-verified 2026-07-12:

1. **The R2 budget gate** — atomic multi-scope worst-case reserve → settle with streamed
   pop-once settle ([ADR-0019](decisions/0019-inference-gateway.md)/[0026](decisions/0026-gateway-hot-path-authn-authz-budget.md)/[0028](decisions/0028-own-the-gateway-engine.md)).
   AgentCore's nearest artifacts — Gateway token-limit policies, Harness `maxTokens`,
   Payments `maxSpendAmount` — are respectively a per-request cap, a per-invocation cap,
   and a commerce wallet. **LIVE** ([ADR-0039](decisions/0039-gateway-on-the-serverless-substrate.md)).
2. **Claims/allowances** — onboarding as policy, per-claim default-deny (R5,
   [ADR-0021](decisions/0021-inference-onboarding-policy.md)).
3. **Two-lane governance + showback** — dollar budget (402) vs run quota (429) for
   foreign-L1 agents where dollars are unmeterable; `costUsd` as attribution, not
   enforcement ([ADR-0036](decisions/0036-foreign-l1-boundary-governance.md)).
4. **Capability-bounded egress** — per-run repo-scoped tokens, pkt-line push policy,
   `/v1/*`-only inference leg ([ADR-0034](decisions/0034-egress-sidecar-credential-injection.md)).
5. **Tenancy stamped-from-identity-never-asserted** across every write surface
   ([ADR-0038](decisions/0038-agent-onboarding-behind-the-gate.md)/[0041](decisions/0041-machine-identity-cognito-m2m.md)).
6. **The services-vs-libraries trust line** and the external-agent-has-no-Run resource
   model ([ADR-0040](decisions/0040-coded-agents-services-vs-libraries.md)).
7. **Inbound webhook/event ingestion** — missing on *both* sides; whoever builds it, the
   verification/dedup/mapping logic is ours ([postures §3.4](agentcore-postures.md)).
8. **Portability itself** (R6) — the ports are what make every other row a dial.

And the inverse ledger — where we hand-rolled what managed gives away, the honest cost of
the platform: run dispatch/lifecycle + streaming/resume (vs Runtime), MCP
pooling/credential custody/3LO (vs Gateway+Identity), vector memory + retrieval (vs
Memory), offline JWT/JWKS verification (vs authorizers), and an eval harness we simply
don't have (vs Evaluations). Three of those five are also *undeployed* on the live
profile (tool-gateway, long-term memory, OPA) — which is worth reading as a signal: the
rows where we hand-rolled *and then didn't ship* are the rows where the managed option
costs the least to adopt.

---

## Sources

AgentCore, verified 2026-07-12:
[overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) ·
[release notes](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/release-notes.html) ·
[pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) ·
[quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) ·
[Harness](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html) / [operations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-operations.html) ·
[Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html) ·
[Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) / [namespaces](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html) ·
[Gateway](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html) / [targets](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-supported-targets.html) / [inference connector](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-inference-connector.html) ·
[Identity](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/identity.html) / [OBO](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html) ·
[Policy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy.html) / [limitations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-limitations-section.html) ·
[Evaluations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations.html) / [built-ins](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/prompt-templates-builtin.html) ·
[Optimization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/optimization.html) ·
[Registry](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry.html) ·
[Payments](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/payments.html) ·
[Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html) ·
[Browser](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html) ·
[Observability](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability.html).
Security: [BeyondTrust CI DNS exfil](https://www.beyondtrust.com/blog/entry/pwning-aws-agentcore-code-interpreter) (remediated per Apr 2026 update) ·
[Unit 42 isolation bypass](https://unit42.paloaltonetworks.com/bypass-of-aws-sandbox-network-isolation-mode/) ·
[Unit 42 Agent God Mode](https://unit42.paloaltonetworks.com/exploit-of-aws-agentcore-iam-god-mode/) ·
[VPC-mode DNS follow-up](https://haitmg.pl/blog/aws-bedrock-agentcore-network-modes/).
Internal: [agentcore-postures.md](agentcore-postures.md) · [costs.md](costs.md) ·
ADRs [0024](decisions/0024-build-vs-buy-managed-agent-platforms.md), [0031](decisions/0031-serverless-substrate-for-the-run-loop.md)–[0041](decisions/0041-machine-identity-cognito-m2m.md).
