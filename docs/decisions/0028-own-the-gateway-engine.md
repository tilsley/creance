# ADR-0028: Own the gateway engine — retire LiteLLM from the serving path

- **Status:** Proposed (reverses the buy-the-engine half of [0013](0013-inference-cost-enforcement.md)/[0024](0024-build-vs-buy-managed-agent-platforms.md)/[0026](0026-gateway-hot-path-authn-authz-budget.md) for the gateway; the build-the-policy half carries over verbatim. Revises [0027](0027-two-deployment-profiles.md): two profiles, **one** gateway)
- **Date:** 2026-06-10

## Context

The LiteLLM pivot ([0024](0024-build-vs-buy-managed-agent-platforms.md)) bet *buy the engine,
build the policy*: LiteLLM owns wire formats, routing, and the Bedrock call; our OSS hooks own
verified-identity authn + the worst-case budget hard-stop. Milestones 1–4 proved the policy
half works. But the operating record since then is an argument **against** the engine half:

**1. Every security-critical line is already ours.** [0026](0026-gateway-hot-path-authn-authz-budget.md)
established that LiteLLM's native JWT authn is an enterprise upsell we decline and the
worst-case pre-flight admission is *unbuyable at any tier* — so the engine contributes zero
of the controls that make the gateway a gateway. What we actually bought: wire formats,
multi-provider routing, and pricing tables. We invoke **Bedrock only**, so the 100-provider
router is dead weight; we price independently in the admission hook already.

**2. The hook seam keeps failing open.** Enforcement hangs off `CustomLogger` callbacks whose
signatures and call sites are LiteLLM-internal and have drifted under us repeatedly — and the
failure mode is *silent admission bypass*, not an error:

| Incident (all caught by our own tests, pinned to 1.87.0) | Failure mode |
|---|---|
| `async_pre_call_hook` fires with `call_type="acompletion"`, not `"completion"` | guard mismatch → **admission silently skipped** |
| `/v1/messages` routes as `call_type="anthropic_messages"` | **complete budget bypass** on the Anthropic wire |
| `/v1/messages` success hook receives a dict, usage keyed `input/output_tokens` | `actual=0` → full refund → **spend never accumulates** |
| streaming: `async_post_call_success_hook` **never fires** for `stream=true` | every streamed call billed at worst-case (fix: the pop-once reservation stash, commit `c07766a`) |
| LiteLLM mutates `DATABASE_URL` (appends `connection_limit`) | collides with our Postgres store → hence `SPEND_DATABASE_URL` |
| upstream budget bugs [#24770](https://github.com/BerriAI/litellm/issues/24770), [#12905](https://github.com/BerriAI/litellm/issues/12905) | LiteLLM's *own* budgets documented **fail-open** |

Each LiteLLM version bump re-rolls these dice. A choke point whose enforcement is a callback
into a ~million-line Python proxy that fails open is a worse **security posture** than ~500
lines of TS where the gate is structural — a request *cannot* reach Bedrock except through
our code, and our error path is a refused request, not a skipped hook.

**3. The bespoke gateway already exists.** [0027](0027-two-deployment-profiles.md) kept the Bun
gateway as cheap-mode/frozen-reference. It already does verified authn (TokenReview/JWKS,
mesh-trust), claim routing, atomic reserve/settle, and self-service claims through the same
`@agent-os/core` adapters the runtime uses. The gap to "the only gateway" is the wire: agent
clients (OpenCode/`@ai-sdk/anthropic`, Claude Code) speak the **Anthropic Messages wire and
always stream**; the Bun gateway serves one bespoke non-streaming JSON endpoint.

## Landscape 1 — which Bedrock API per wire (verified June 2026)

Bedrock offers two invocation APIs; the right one depends on which side of the gateway the
translation lives:

| | [`InvokeModel(WithResponseStream)`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html) | [`Converse(Stream)`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html) |
|---|---|---|
| Request body | the **native Anthropic Messages body** (`anthropic_version` added, `model` moves to the URL) | AWS's own normalized schema (`messages`/`toolConfig`/…) |
| Stream chunks | **literal Anthropic events** (`message_start`, `content_block_delta`, `message_delta` w/ usage) in AWS event-stream framing | Converse event shapes (`contentBlockDelta`, `metadata` w/ usage) |
| New Anthropic features (thinking, `cache_control`, tool variants) | flow through untouched | lag; squeezed via `additionalModelRequestFields` |
| Fit | **passthrough** for an Anthropic-wire endpoint | **translation target** for any non-native wire; model-agnostic; inline `guardrailConfig` |

So: for the Anthropic endpoint translation is *avoidable* — avoid it (InvokeModel). For any
endpoint where translation is *unavoidable* (OpenAI wire, our neutral port), Converse is the
cleaner target and AWS maintains the model-side normalization. All AI SDKs in the
OpenAI/Anthropic mold consume **SSE** on streaming responses — but the contract is the
*dialect*, not just SSE: Anthropic's named-event grammar in sequence vs OpenAI's `data:`
chunks + `[DONE]`. Bedrock hands us the Anthropic dialect pre-formed; the gateway's streaming
job is exactly the event-stream→SSE re-framing.

## Landscape 2 — workload authn at a multi-tenant gateway (added 2026-06-12)

How other teams answer "which workload is calling me?", ordered by coupling. The question
matters here because the gateway needs identity **in the app** (to pick the claim, debit the
budget, route the model) — mesh-level `AuthorizationPolicy` alone can't debit a budget.

| Pattern | Who does it | Verdict for us |
|---|---|---|
| 1. Gateway-minted API keys per team | Most LLM-gateway deployments today (LiteLLM virtual keys, Portkey, Kong consumers) | **Rejected in [0019](0019-inference-gateway.md)** — a long-lived bearer names a budget line, not a workload |
| 2. Platform-verified tokens (projected SA JWT → TokenReview/JWKS; OAuth2 client-creds off-k8s) | The k8s-industry standard — IRSA, Vault k8s auth, GCP WI all reduce to it | **Our cheap mode** (`AUTHN=oidc-sa`) — the most conventional piece of the design |
| 3. Mesh mTLS identity consumed by the app (Linkerd `l5d-client-id` / Istio-Envoy XFCC; gRPC peer info in ALTS/BeyondProd shops) | Minority pattern — teams with per-caller metering/tenancy/audit, i.e. our exact problem | **Our full mode** (`AUTHN=mesh-id`) — one adapter, two header dialects, both documented mechanisms of their mesh |
| 4. Policy-sidecar binding (ext_authz/OPA validates the principal, injects a sanitized tenant header; Netflix "Passport") | Large platform orgs — incl. the org's Istio+OPA stack | **The upgrade path, not a competitor** — relocates the identity→tenant binding into the policy plane; slots in at the `Authorizer` port, the identity header still gets read |
| 5. SPIFFE/SPIRE direct (app terminates mTLS, reads SVID) · cloud IAM (SigV4→STS) | Uber/Bloomberg-style SPIRE shops; AWS-native estates | Future adapters behind the same `Authenticator` port ([0019](0019-inference-gateway.md) already names SigV4) |

Two notes that decided it: **(a)** header-parsing is normal *for this minority* — `l5d-client-id`
and XFCC are each mesh's documented way to surface the verified peer to the app; the headers are
only trustworthy because the inbound proxy sets them and strips client-supplied copies, so the
gateway must be reachable only through the mesh (encoded in the adapter doc + a live forgery
test). **(b)** the agent-platform twist favors mesh identity more than ordinary microservices:
our callers run model-generated, prompt-injectable work, and a token a pod holds is a token a
hijacked agent can exfiltrate — in mesh mode **there is no credential in the pod to steal**.
Identity is the only thing taken from the header; tenant/authority always comes from the claim
binding, default-deny, same as the TokenReview path.

## Decision

**The Bun/TS gateway becomes the single gateway in both deployment profiles. LiteLLM is
demoted from engine to conformance reference and retired from the serving path once parity
gates pass. Bedrock-only; the wire↔API matrix is deliberate:**

| Endpoint | Clients | Bedrock API | Translation |
|---|---|---|---|
| `POST /v1/messages` (Anthropic wire, SSE streaming) — **new** | OpenCode, Claude Code, Anthropic SDKs | `InvokeModelWithResponseStream` | ~none: compat scrub in, event-stream→SSE re-framing out |
| `POST /v1/generate` (bespoke neutral wire) — exists | our runtime via the `InferenceProvider` port | `Converse` (unchanged, [bedrock-inference.ts](../../packages/core/src/adapters/bedrock-inference.ts)) | already done |
| `POST /v1/chat/completions` (OpenAI wire) — **deferred** | none today (it existed because it was LiteLLM's default) | `ConverseStream`, when built | OpenAI↔Converse maps near field-for-field |

1. **Anthropic wire = authenticated, budget-gated passthrough.** Verify identity → resolve
   claim → worst-case reserve (`max_tokens` is in the body) → strip `model` to the profile ARN,
   add `anthropic_version`, scrub client-SDK skew (the `compat_hook` job — e.g.
   `eager_input_streaming`) → `InvokeModelWithResponseStream` → decode AWS event-stream framing,
   re-emit each chunk verbatim as Anthropic-dialect SSE. No semantic translation layer to
   maintain as Anthropic ships features.

2. **Port the streamed-spend lessons (`c07766a`), don't rediscover them.** Settle from the
   stream's `message_delta`/`message_stop` usage via a **pop-once reservation** keyed per call —
   whichever completion path fires first (stream end, failure, client disconnect) settles
   exactly once. Client disconnect aborts the upstream Bedrock stream. Abandoned reservations
   stay spent (**over-charge, never a budget hole**) and are swept after 1h. Flush per SSE
   event, no buffering (fine under Linkerd; re-check if an ingress ever fronts it); `event: ping`
   keep-alives are tolerated by Anthropic SDKs.

3. **Hot-path hardening to the [0026](0026-gateway-hot-path-authn-authz-budget.md) spec, in TS.**
   (a) **Default-deny without a claim in both profiles** — closes the cheap-mode flat-budget
   exception [0027](0027-two-deployment-profiles.md) tolerated. (b) TTL grant cache on
   [`DynamoClaimSource`](../../packages/core/src/adapters/dynamo-claim-source.ts) (the kube
   source already caches 30s) — no per-request remote claim read. (c) Port the Postgres
   conditional-`UPDATE` SpendStore from Python to TS for full mode; DynamoDB stays the
   cheap-mode default ([0023](0023-memory-backends-postgres-redis.md)).

4. **The conformance suite is the migration gate** ([0027](0027-two-deployment-profiles.md)'s
   `make gate-conformance`). Extend it with: streaming settle-to-actual, default-deny, the
   forgery defense on `/v1/messages`, and the wire-scrub case. LiteLLM must keep passing
   identically until the suite says the Bun gateway covers everything the deploy path uses —
   then `charts/litellm-gateway` is retired and `services/inference-gateway/litellm/` is kept
   only as the documented reference of the hook-seam findings.

5. **Two profiles survive, one engine.** [0027](0027-two-deployment-profiles.md)'s
   cheap-vs-full split now differs only in *backing*, not gateway: cheap = Bun + DynamoDB +
   offline JWT, scale-to-zero; full = the same Bun gateway + Postgres/Redis + mesh-trust + OPA.
   The TS/Python drift risk [0027](0027-two-deployment-profiles.md) accepted disappears — one
   gate implementation, one language.

```
client (Anthropic SSE)                 runtime (neutral port)
  └─▶ /v1/messages                       └─▶ /v1/generate
        │  authn → claim (default-deny) → reserve (pop-once)   ← shared TS gate, one impl
        │  compat scrub                        │
        ▼                                      ▼
  InvokeModelWithResponseStream           Converse
        │  Anthropic events ──▶ SSE            │
        └────────── settle-to-actual from usage ──────────┘
  deferred: /v1/chat/completions → ConverseStream (when a real OpenAI-SDK client exists)
```

## Consequences

- **+** The gate becomes **structural, not a callback seam**: no request reaches Bedrock except
  through our code; version bumps can't silently skip admission. The fail-open class of bug is
  closed by construction.
- **+** Attack surface and supply chain shrink from a ~million-line Python proxy (+ Prisma, its
  own DB, enterprise code paths) to ~hundreds of lines of TS on adapters we already test.
- **+** One language, one gate implementation — [0027](0027-two-deployment-profiles.md)'s
  TS/Python drift risk and dual infra footprint go away; scale-to-zero now applies to *both*
  profiles.
- **+** Anthropic features arrive for free on the passthrough wire (no translation layer to
  update); Bedrock-only makes the lost router genuinely costless today.
- **−** **Wire formats are ours now.** Client-SDK vintage skew (the `compat_hook` class of
  problem) becomes a permanently maintained surface, and the SSE re-framing must be kept
  dialect-correct — the conformance suite is the guard.
- **−** No OpenAI-wire endpoint until a real client needs one; multi-provider routing and
  LiteLLM's pricing tables are gone (we price independently already; a second provider would
  be a new adapter behind the port, per [0003](0003-ports-and-adapters.md)).
- **−** Reverses [0027](0027-two-deployment-profiles.md)'s "frozen reference" stance: the Bun
  gateway is now the live product and takes the streaming/wire investment.
- **−** The Python Postgres reserve/settle gets re-ported to TS (small — one conditional
  `UPDATE`), and the Aurora IAM-auth path re-validated from the TS side.

## Relationship

Reverses the **buy-the-engine** half of [0013](0013-inference-cost-enforcement.md)/[0024](0024-build-vs-buy-managed-agent-platforms.md)
*for the gateway only* — the build-the-policy half (worst-case admission, verified authn,
claim model) carries over unchanged, and [0024](0024-build-vs-buy-managed-agent-platforms.md)'s
managed-platform-as-adapter stance for sandbox/tools is untouched. Realizes the
[0019](0019-inference-gateway.md) choke point in a single implementation; keeps the
[0026](0026-gateway-hot-path-authn-authz-budget.md) hot-path rules (now enforced in TS);
revises [0027](0027-two-deployment-profiles.md) to *two profiles, one gateway*; claims
([0021](0021-inference-onboarding-policy.md)), stores ([0023](0023-memory-backends-postgres-redis.md)),
and the ledger ([0025](0025-cost-allocation-in-the-ledger.md)) are unchanged. One-liner:
**own the engine after all — the policy was always ours, the hook seam kept failing open, and
Bedrock-only makes the bought 90% dead weight; Anthropic wire by InvokeModel passthrough,
Converse behind every translated wire.**

## Sources

- Bedrock [`Converse`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html) / [`InvokeModelWithResponseStream`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModelWithResponseStream.html) — request/stream shapes
- [Anthropic Messages streaming](https://docs.anthropic.com/en/docs/build-with-claude/streaming) — the SSE event grammar the SDKs validate
- LiteLLM fail-open budget bugs — [#24770](https://github.com/BerriAI/litellm/issues/24770), [#12905](https://github.com/BerriAI/litellm/issues/12905); our own findings in [`services/inference-gateway/litellm/README.md`](../../services/inference-gateway/litellm/README.md) ("Validation caveats")
- Commit `c07766a` — streamed-spend settle (the pop-once reservation) + wire-compat scrub
