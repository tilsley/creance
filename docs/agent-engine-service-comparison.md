# agent-os × GCP Gemini Enterprise Agent Platform — the service-by-service ledger

> **The GCP sibling of [`agentcore-service-comparison.md`](agentcore-service-comparison.md).**
> Same question, different managed platform: for each GCP **Gemini Enterprise Agent
> Platform** (GEAP — the rebrand of "Vertex AI Agent Builder / Agent Engine") service,
> what it gives us for free that we hand-rolled, what it gives us that we don't have at
> all, and what it does *not* provide that we built.
>
> This backs the **fourth deployment profile** — `managed Agent Engine` — the GCP analog
> of [ADR-0042](decisions/0042-agentcore-managed-profile.md)'s AgentCore profile. Same
> contract, same invariant shell (the gate, the inference gateway, the front door, the
> claude-code lane), different managed richness. Selected by env bundle like the other
> three ([ADR-0027](decisions/0027-two-deployment-profiles.md)).
>
> **Status: v1 scaffold.** GEAP facts checked against live docs **2026-07-14**; rows I
> have *not* yet verified against docs or code are marked **⚠️ verify**. Harden before
> promoting to an ADR. Our side is the live serverless posture (Lambda front door +
> Fargate task-per-run), same baseline as the AgentCore ledger.

---

## Naming note — the 2026 rebrand

What AWS calls **AgentCore** (one service, many sub-capabilities), GCP now calls the
**Gemini Enterprise Agent Platform**, and the old "Vertex AI Agent Engine" name has split
into named siblings. The mapping we care about:

| Concept | AWS AgentCore | GCP GEAP |
|---|---|---|
| Host the loop | Runtime (per-session microVM) | **Agent Runtime** (deploy container / ADK / source) |
| Conversation + run state | Runtime sessions | **Sessions** |
| Managed memory | Memory | **Memory Bank** |
| Sandbox / code exec | Code Interpreter | **Code Execution** + **Sandbox (BYOC)** |
| Tool endpoint | Gateway (MCP) | tool config / MCP · **⚠️ verify** GEAP MCP-gateway surface |
| Credential custody | Identity (token vault, 2LO/3LO) | **Identity Platform** + Secret Manager + WIF |
| Inbound authn | (custom JWT authorizer) | SA **OIDC JWT** (GA) or SPIFFE **Agent Identity** (Preview) — see [Agent identity](#agent-identity-on-gcp--sa-oidc-vs-spiffe-and-the-istio-question) |
| Workload identity | (SA + IRSA/Pod Identity chain) | **SPIFFE X.509 SVID** per agent (mTLS + DPoP) · Preview |
| Eval | Evaluations | **Gen AI Evaluation** |
| Registry | Registry | **⚠️ verify** (Agentspace / agent catalog) |

**Three distinct "custom container" surfaces on GCP** — do not conflate (verified 07-14):
1. **Agent Runtime** container deploy (`container_spec.image_uri`) — *this hosts the loop.*
2. **Sandbox BYOC** (`SandboxEnvironmentTemplate`) — the code-exec sandbox = Model-B analog.
3. **Custom container for inference** (`/predict`+`/invoke`, `{"instances":…}`) — classic
   Vertex model-serving, **not** the agent. Irrelevant to us.

---

## TL;DR — the ledger in one table

| GEAP service | Free stuff we hand-rolled | Free stuff we don't have | What it *doesn't* provide (ours) | Our counterpart · status |
|---|---|---|---|---|
| **Agent Runtime** | session lifecycle, autoscale, container/source/Dockerfile/Git deploy, managed identity | sub-second cold start, managed scaling knobs | **budget gate on think**, substrate portability, the front door/control plane | Fargate task-per-run · **LIVE** |
| **Sessions** | conversation + run state store | managed session persistence out of the box | the run *ledger* (claims/allowances, reserve→settle) | run-store (DynamoDB) · **LIVE** |
| **Memory Bank** | event store, extraction, retrieval | episodic strategies, managed recall · **⚠️ verify** namespace/IAM enforcement | files-first transparency, guard-on-write | files/vector memory · **BUILT (unwired live)** |
| **Code Execution / Sandbox BYOC** | (we already buy a sandbox) | managed code-exec, BYO image via `SandboxEnvironmentTemplate` | egress capability-bounding · **⚠️ verify** GEAP egress control | `AgentCoreSandboxProvider` · **LIVE** |
| **Tools / MCP** | MCP client, per-tool policy | tool governance, connectors · **⚠️ verify** managed MCP gateway | **inference budget admission** | `tool-gateway` · **BUILT (k8s)** |
| **Identity Platform + WIF** | JWT authn, token exchange · **⚠️ verify** OBO/3LO parity | Secret Manager refs, keyless federation (WIF) | tenancy *stamped* from identity, per-run scoped tokens, egress sidecar | 8 authn adapters + OBO + sidecar · **LIVE/BUILT** |
| **Gen AI Evaluation** | — | evaluators, batch/online · **⚠️ verify** vs AWS 16-evaluator set | — | none — named gap (same as AgentCore) |
| **Registry / catalog** | agent catalog · **⚠️ verify** | curation · **⚠️ verify** | **gated onboarding** (authz + tenant stamping), claims | `POST /agents` + registry · **BUILT** |
| **Observability** | (we buy Grafana Cloud) | Cloud Trace GenAI UI · **⚠️ verify** OTLP ingest | — | OTLP → Grafana · **LIVE** |
| **Payments / commerce** | — | **⚠️ verify** GCP has an analog | it is *not* inference budgeting | deliberately none (≠ R2) |

The **two structural absences** that held in every AgentCore row — re-check they hold for GEAP:

1. **Inbound webhook/event ingestion** — AgentCore had none; **⚠️ verify** whether GEAP's
   Agentspace/Gemini Enterprise front changes this. (We designed it away, [ADR-0040](decisions/0040-coded-agents-services-vs-libraries.md).)
2. **Pre-flight per-tenant budget admission on inference** — AgentCore explicitly can't;
   **⚠️ verify** GEAP has no reserve/settle either. The R2 gate
   ([ADR-0019](decisions/0019-inference-gateway.md)/[0026](decisions/0026-gateway-hot-path-authn-authz-budget.md))
   stays ours — this is the thesis; confirm it survives the GCP cut.

---

## The invariant shell — identical in the GCP profile

Restated for the fourth time, deliberately (mirrors [ADR-0042](decisions/0042-agentcore-managed-profile.md)):
the gate (atomic reserve→settle), the claims/allowance model, tenant-stamped-from-identity,
guard placement, and the run ledger are **the same** whether the loop runs on Fargate, EKS,
AgentCore Runtime, or **GEAP Agent Runtime**. GEAP hosts the loop container; it does not host
an enforcement point. That is the line that separates "a fourth profile" from "adopting
someone else's loop."

### The lane that can't lean in — same boundary

The claude-code / foreign-L1 lane stays on **Cloud Run** (the GCP Fargate analog) in this
profile too, for the same reasons it can't lean into AgentCore Runtime: fixed compute
envelope, no sidecar seat for credential substitution, no domain-based egress wall.
"Managed Agent Engine" honestly means *managed for metered agents* — [ADR-0036](decisions/0036-foreign-l1-boundary-governance.md).

---

## Agent identity on GCP — SA OIDC vs SPIFFE, and the Istio question

Research (2026-07-14) into *"what identity does a GEAP agent actually present, and can an
external Istio mesh authorize on it?"* — this resolves the Identity rows above and
open-question #5. **Two distinct identity models are available on Agent Runtime:**

| Model | What the agent presents | How an external verifier checks it | Maturity |
|---|---|---|---|
| **SA OIDC token** (what we mint today) | Google-signed OIDC JWT from the metadata server (`iss=accounts.google.com`, claims `email`/`sub`/`azp`/`aud`) for the runtime's service account | Istio **`RequestAuthentication`** (issuer + `jwksUri=googleapis.com/oauth2/v3/certs`) + **`AuthorizationPolicy`** on `request.auth.claims[email]` | **GA** — works now |
| **GCP Agent Identity** | SPIFFE **X.509 SVID**, `spiffe://agents.global.org-<ORG>.system.id.goog/resources/aiplatform/…/reasoningEngines/<id>`, mTLS (+ **DPoP** across Agent Gateway), 24h auto-renewed | Istio `source.principals` on the SPIFFE ID — **but** needs SPIFFE **trust-domain federation** (import GCP's trust bundle) | **Preview / pre-GA** |
| **Solo.io `agentgateway` + WIMSE** | SPIFFE identity carried in a **`Workload-Identity-Token`** header across egress | Istio ambient waypoint validates the WIT — mesh-native, purpose-built for this | separate product you deploy |

**The findings that matter:**

- The **SA OIDC token is the pragmatic path today.** It's GA, the SA **email is deterministic**
  (`agent-runtime@<project>.iam.gserviceaccount.com`), and Istio validates it with stock
  `RequestAuthentication`. Match on the `email` claim, *not* `sub` — the numeric `sub`/uniqueId
  is assigned at SA creation and **changes on recreate**. A **no-service-account** deploy resolves
  to the shared Google-managed Reasoning Engine service agent
  (`service-<projectNumber>@gcp-sa-aiplatform-re.iam.gserviceaccount.com`) — so agents deployed
  without a pinned SA are **indistinguishable** in the mesh. Pin a per-agent SA to get per-agent identity.
- **GCP Agent Identity *is* SPIFFE-based** and is the more "correct" long-term model (per-agent
  `spiffe://…/reasoningEngines/<id>`, short-lived certs, mesh-native `source.principals`). Three
  real frictions before it works with an external Istio: (1) **trust-domain federation** — your
  mesh CA doesn't trust `agents.global.org-….system.id.goog`; (2) the **egress-to-external-Istio
  path is undocumented** — the docs cover mTLS to *Google Cloud APIs* and across *GCP's own Agent
  Gateway*, not how an off-GCP verifier receives the SVID; (3) **DPoP isn't natively validated by
  Istio**. Plus it's Preview. And its SPIFFE ID encodes the `reasoningEngines/<id>`, which — like
  the SA `sub` — **changes per redeploy**, unlike the deterministic SA email.
- **"Egress via agent gateway adds a SPIFFE header"** is true of **Solo.io's `agentgateway`**
  (WIMSE `Workload-Identity-Token`), *not* GCP's Agent Gateway. The WIMSE insight is the general
  one: mTLS/SPIFFE X.509 identity is **scoped to a single connection**, so carrying agent identity
  across an egress hop into a mesh needs either trust federation (X.509) or an identity-in-header
  token (WIMSE WIT / JWT-SVID).

**Bottom line for the profile:** the invariant shell already stamps tenancy from the *inbound*
identity at the gate; for mesh interop the **SA OIDC token is what we'd wire first** (GA,
deterministic, stock Istio). GCP Agent Identity (SPIFFE) is the aspirational upgrade once it's GA
and trust-federation is documented. *Sources: GCP Agent Identity overview & Agent Gateway codelab;
Solo.io "Can SPIFFE work for agents"; Istio SPIRE-integration docs; IETF WIMSE.*

---

## Cost shape — the pull toward this profile

GEAP Agent Runtime bills **~$0.0864/vCPU-hr + $0.0090/GB-hr** while a session is active, plus
Sessions/Memory storage at ~$0.25/1k events (verified 07-14), and scales down when idle. Same
active-CPU story as AgentCore Runtime: for a loop that mostly waits on the model, this is
plausibly cheaper than Fargate wall-clock billing — the exact argument [ADR-0042](decisions/0042-agentcore-managed-profile.md)
makes for the AWS managed profile. Fits [ADR-0024](decisions/0024-build-vs-buy-managed-agent-platforms.md)'s
build-vs-buy curve at a fourth operating point.

---

## Open questions to close before ADR (the ⚠️-verify backlog)

> **[ADR-0044](decisions/0044-gcp-agent-runtime-profile.md) is now written** (Accepted,
> 2026-07-18) on the strength of the resolved rows below — phases 1–3 (loop on Runtime →
> Vertex Gemini → front-door dispatch via a shared Firestore ledger) are verified live. The
> still-open items (#3 Memory Bank isolation, #4 managed MCP, #5 the 2LO/3LO OBO custody
> pattern, #6 inbound events/budget admission) are carried into the ADR as **named open
> phases (4–6)**, not blockers.

1. ✅ **RESOLVED (2026-07-14) — live invoke proven.** Agent Runtime POSTs the `:query` body to
   **`POST /api/reasoning_engine`** as `{"input":{…}}` on `AIP_HTTP_PORT`=8080; the container must
   return **`{"output": <value>}`** (the platform relays the body as the `:query` response schema).
   Deploy: `container_spec`=image only, no command override (Dockerfile `AGENT_ENTRYPOINT`
   env-indirection); `env_vars`/`service_account`/`min_instances` top-level. **code-13** was the
   Reasoning Engine service agent lacking Artifact Registry read (fixed in Pulumi). Full write-up:
   [`deploy/gcp-agent-engine/README.md`](../deploy/gcp-agent-engine/README.md).
2. ✅ **RESOLVED (2026-07-18) — region is `europe-west2` (London), not `us-central1`.** Chosen to
   mirror the AWS primary `eu-west-2`; Agent Runtime, Firestore and Vertex Gemini (`gemini-2.5-flash`,
   the only flash in ew2) are all confirmed there. Memory Bank availability in ew2 is the one row
   still to confirm when that phase starts.
3. **Memory Bank per-tenant isolation** — is there an IAM-condition-key equivalent to
   AgentCore Memory's namespace enforcement, or is isolation app-level?
4. **Managed MCP gateway** — does GEAP expose an MCP endpoint (AgentCore Gateway analog), or is
   tool wiring purely in-agent?
5. ✅ **PARTIALLY RESOLVED (2026-07-14) — agent identity mapped.** The runtime presents a GA
   **SA OIDC JWT** (Istio-verifiable today, deterministic email) *or* a Preview SPIFFE **Agent
   Identity** (X.509 SVID, mTLS + DPoP). See the [Agent identity](#agent-identity-on-gcp--sa-oidc-vs-spiffe-and-the-istio-question)
   section. Still open: the **2LO/3LO OBO custody** pattern (Identity Platform + Secret Manager +
   WIF vs AgentCore Identity's token vault) — the *outbound* credential-vault story, distinct from
   the inbound-identity question now answered.
6. **Inbound events & budget admission** — confirm the two structural absences hold.

---

*Sources (2026-07-14): GEAP docs — Agent Runtime / deploy-an-agent, Sandbox custom-containers,
platform overview; Agent Builder 2026 pricing; Agent Identity overview + Agent Gateway codelab;
Solo.io "Can SPIFFE work for agents"; Istio SPIRE integration; IETF WIMSE. Update this line as
rows are verified.*
