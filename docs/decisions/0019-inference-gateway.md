# ADR-0019: Promote the inference gateway to a standalone, identity-bound choke point

- **Status:** Accepted — built across slices 1-5 + validated on the local-k3s e2e (extends [0004](0004-cost-governance.md) + [0013](0013-inference-cost-enforcement.md); hardens identity from [0014](0014-per-tenant-workload-identity.md)/[0015](0015-split-authn-authz-ports.md))
- **Date:** 2026-05-30

## Context

[ADR-0004](0004-cost-governance.md) named an **in-path inference gateway** as the only
place a real-time cap can live (AWS billing lags). [ADR-0013](0013-inference-cost-enforcement.md)
surveyed build-vs-buy and implemented admission as a **decorator over the
`InferenceProvider` port, inside the runtime** — the worst-case-dollar pre-flight that
stops a single $50 one-shot. Good for our own hosted agents.

Three things now force the gateway to grow up from an in-process decorator into a
**standalone component every model call routes through**:

1. **A new consumer.** The headline use case is no longer "a human runs a hosted
   agent." It's *"I'm a deployed service with its own cloud identity; grant me
   inference via a CRD, with a budget, that only I can use."* That caller never enters
   our runtime — so the choke point must be a **service it calls**, not a library
   inside our loop.

2. **The trust root is stubbed.** Identity today arrives in an *unverified*
   `x-agentos-identity` header ([MeshTrustAuthenticator](../../packages/core/src/adapters/mesh-trust-authenticator.ts)
   decodes without checking a signature — "the edge did it"). On the EKS field trip
   there *was* no edge; we injected the header. Isolation was therefore by convention,
   and the base role could assume `agentos-*` (**any** tenant). A real consumer must
   **prove** its identity.

3. **One monthly cap isn't enough.** A single uninterrupted session can burn $1000
   well inside a monthly budget. And the counter is check-then-add — a **TOCTOU race**:
   concurrent calls both read under-cap, both spend. The cap must be **multi-scope**
   (tenant/month *and* session/run) and **atomic**.

These are not a rewrite — the ports, primitives/controls, per-tenant roles, OBO chain
([0016](0016-obo-token-vault.md)/[0017](0017-a2a-identity-propagation.md)) and the
DynamoDB counter all survive. It's a **relocation + hardening**: the gateway moves out
of the loop into a service, identity becomes verified, the budget gains a scope and
becomes atomic.

## Landscape (verified May 2026)

Updates [0013](0013-inference-cost-enforcement.md)'s table with what changed this month.
The category is mature; the differentiator we keep building is the *identity-bound,
self-service* layer, not the budget engine.

| Tool / feature | What's new / relevant | Fit |
|---|---|---|
| [LiteLLM Proxy](https://docs.litellm.ai/docs/proxy/users) — [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys) | **Multi-window budgets** now first-class: `$10/day` **and** `$100/month` on one key; team `model_rpm/tpm` limits; 100+ providers incl. Bedrock | **Buy** the engine. It does exactly our multi-scope budget — but keyed on *its own* virtual keys, not a verified cloud identity, and still **accumulation-only** (not worst-case pre-flight). Fail-open budget bugs persist ([#24770](https://github.com/BerriAI/litellm/issues/24770), [#12905](https://github.com/BerriAI/litellm/issues/12905)) |
| [Bedrock AgentCore **Payments**](https://aws.amazon.com/bedrock/agentcore/) (preview, **announced 2026-05-07**) | `PaymentSession` with `maxSpendAmount` + expiry, denies over-limit. AWS's own framing: *"the spending limit is the product."* | **Adjacent, not it.** Scopes spend for **agent payments to external paid resources** (HTTP 402 / x402 micropayments to APIs/MCP/other agents) — **not** a cap on `InvokeModel`. Even AWS's newest spend primitive does not cap inference spend. |
| [Bedrock app inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html) | tagged attribution → Cost Explorer/CUR; **quota 1,000/account** (verified live, adjustable) | Attribution + the per-tenant unit. **Not** enforcement. |
| [Envoy AI Gateway](https://aigateway.envoyproxy.io/) · [Bifrost](https://github.com/maximhq/bifrost) · [Kong AI Gateway](https://konghq.com/blog/engineering/ai-gateway-benchmark-kong-ai-gateway-portkey-litellm) | The **performance** tier: Bifrost claims `<11µs` overhead at 5k RPS (~50× LiteLLM); Kong benchmarks ~8× LiteLLM | Matters *because* the gateway is now in the path of **every** call. LiteLLM is flexible/free but not the fastest; revisit if gateway latency bites. |
| [AWS Budgets + Budget Actions](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html) | unchanged: auto-Deny at threshold | **Backstop only** — hours-lagging, off-path. |

Honest takeaways, confirmed again in writing: **(1)** Bedrock still has **no native
real-time `InvokeModel` dollar cap** — a hard cap *must* be added in-path. **(2)** The
gateway, multi-window budgets, and pre-flight estimation are all **standard** — what's
ours is binding them to a **verified workload identity** provisioned **self-service via
a CRD**.

## Decision

**The gateway becomes a standalone choke point in front of *all* model calls. Buy the
budget/routing engine; own the identity, isolation, admission, and self-service plane.**

1. **One choke point, two front doors.** Every model call routes through the gateway.
   - *Deployed service* → calls the gateway as itself (its own identity, its own claim).
   - *Human → hosted agent* (still valid) → the agent-runtime calls the gateway **on
     behalf of** the human via OBO ([0016](0016-obo-token-vault.md)/[0017](0017-a2a-identity-propagation.md)).
   The runtime's `InferenceProvider` becomes a thin **gateway-client adapter**; the real
   Bedrock/Copilot providers + the budget engine move **behind** the gateway. Same port,
   relocated — and **provider-agnostic** (GitHub Copilot, with its per-user attribution,
   is then just another back-end adapter, not a rewrite).

2. **Verified identity (the trust-root fix).** `OidcServiceAccountAuthenticator` behind
   the existing `Authenticator` port: verify the caller's projected **K8s ServiceAccount
   JWT** against the cluster OIDC issuer (JWKS) — proves *"I am SA X in namespace Y."*
   Retires `mesh-trust` *as the trust root*. SigV4/IAM stays a future adapter (same port).

3. **Isolation = claim-bound proven identity.** The `InferenceClaim` binds *proven
   identity → tenant*; authz rejects any caller without a matching claim and a caller
   cannot assert another tenant (it can't forge the token). Keep **per-tenant role** (the
   AWS isolation boundary) **+ per-tenant inference profile** (attribution + pins
   `baseModel`). **Drop the `agentos-*` wildcard** — scope the base role's `AssumeRole`
   to the claim's exact role. Ceiling: **1,000 roles + 1,000 profiles per account**
   (verified live, both adjustable) — the real tenant cap; beyond it, raise the quota or
   shard accounts.

4. **Multi-scope, atomic budget.** Enforce **tenant/month + session(or run)** caps
   together; any one failing → refuse. Replace check-then-add with an **atomic
   conditional write** (`UpdateItem ADD spent :c` guarded by `spent + :c ≤ cap`) —
   **reserve worst-case before the call, settle actual after**. Keep [0013](0013-inference-cost-enforcement.md)'s
   worst-case-dollar pre-flight (LiteLLM is accumulation-only) as the per-call admission
   hook. Buy LiteLLM's multi-window engine; own the worst-case admission + the keying on
   *verified identity*.

5. **Self-service onboarding (the scale-of-onboarding answer).** A workload applies an
   `InferenceClaim` (RBAC to do so in its own namespace) and a **controller reconciles**
   role + profile + budget — **no terraform-per-tenant, no human IaC PR**. This is how
   inference onboarding scales; it's also what the field trip faked by hand-setting CRD
   status and patching IAM.

6. **Sandbox is the next ADR, not this one.** Tools still run in-process
   (`SANDBOX_PROVIDER=local`) with the runtime's identity — a real isolated executor is
   priority #3, deferred to a follow-up. Out of scope here.

```
caller (proven identity)
  └─▶ GATEWAY ──1 authn: verify SA/OIDC (or OBO for human→agent)
              ──2 authz: matching InferenceClaim?            ← isolation
              ──3 admission: worst-case $ ≤ remaining, atomic, multi-scope  ← the hard stop
              ──4 (next ADR) gate tools into a sandbox
              └─▶ provider adapter (Bedrock today, Copilot later) → model
  off-path: per-tenant inference profile (attribution) · AWS Budget Action (lagging backstop)
```

## Identity & billing modes (provider-agnostic, part 2)

Provider-agnostic isn't only "route to any model" — it's "route in the **identity/billing
mode** the use case needs." Two modes, which correlate with (but aren't defined by) the
provider:

- **service-account / platform-mediated** (Bedrock, Vertex/Gemini): the provider sees only
  a *tenant/workload* role; the gateway carries the end-user identity and attributes spend
  to the user in *our* ledger — the provider can't see the user. (The ticket-bot pattern;
  ADR-0016's service-account broker.)
- **provider-native OBO** (Copilot/GitHub, or any provider with per-user OAuth + accounts):
  the end-user identity propagates *to the provider*, which meters/bills against the user's
  own seat. (ADR-0016's OBO-vault broker.)

The real axis is **"does the end-user have a first-class account at this provider?"** — not
the vendor. So each **provider adapter declares an `identityMode` capability**
(`service-account | provider-obo`); the gateway resolves the *billing principal* per request
and selects an adapter supporting the needed mode. Budget symmetry falls out: the gateway
*always* enforces our real-time cap; in `provider-obo` mode the provider **also** enforces
the user's own quota — a free second ceiling.

Caveat: provider-native OBO needs every end-user licensed at the provider, *and* the
provider's API must actually expose general inference (Copilot's editor API is
product-scoped; [GitHub Models](https://docs.github.com/en/github-models) is the closer
surface). Encode the *pattern*, validate the vendor.

## Consequences

- **+** Closes the two field-trip security gaps: the **stubbed trust root** (identity now
  cryptographically proven) and **soft isolation / `agentos-*` wildcard** (now scoped to
  the claim's role).
- **+** Makes the budget a **real** hard-stop under concurrency (atomic) and against
  runaway sessions (session scope) — the $1000-session fear addressed.
- **+** Provider-agnostic by construction; multi-provider/attribution (Copilot) is an
  adapter, not a project.
- **+** Self-service via CRD removes the per-tenant terraform bottleneck — onboarding
  scales without an operator in the loop.
- **−** A new network hop in front of every call: latency + an availability dependency
  (the gateway is now critical-path). Note the performance tier (Bifrost/Kong/Envoy) for
  when LiteLLM's overhead matters.
- **−** A reconciling **controller** is new machinery we don't yet run (the trip used a
  controller-less CRD). It owns role+profile+budget lifecycle and their teardown.
- **−** Per-tenant role+profile means **two AWS resources per tenant** and the 1,000/acct
  ceiling; cross-account sharding is the eventual scale story.
- **−** Worst-case admission stays conservative (reserves `maxTokens`); true
  reserve/refund is the upgrade. Inherited from [0013](0013-inference-cost-enforcement.md).

## Security & threat model (Copilot as prior art)

The gateway is a deliberate, **highly-privileged** choke point: it holds the only model
access, sees all prompt/response traffic, and (for us) wields `AssumeRole` into tenant
roles. Concentration is **inherent** — a real-time cap *requires* an in-path key-holder, so
no design removes the centre (it only relocates it; e.g. per-tenant proxies move it to the
provisioning controller). The strategy is therefore: make the centre small and hardened, and
everything around it weak and expiring. GitHub Copilot's proxy ("CAPI") is production prior
art for exactly this shape — its lessons, adopted here:

- **Short-lived everything around the centre.** Copilot's client exchanges a durable
  identity for a ~30-min entitlement-scoped token; provider keys never leave the server.
  Adopt the analogue: a **short-lived, entitlement-scoped token on the caller→gateway hop**
  (reuse the OBO/STS machinery), so the gateway authorises from a verifiable claim, not
  network position.
- **Don't persist payloads; push ZDR downstream.** Copilot discards in-editor prompts and
  holds zero-data-retention agreements with providers (it picks Bedrock *because* it doesn't
  store prompts). The gateway logs **metadata only** (tokens, cost, model, identity) — never
  bodies — and leans on Bedrock no-retention.
- **Inline hard-stop, not just the lagging backstop.** Copilot blocks *at the proxy* when a
  budget is hit. Enforce per-tenant + per-session spend **in the gateway, on the request
  path**; keep the AWS Budget Action as the off-path backstop only. Also scope each tenant to
  **which models** it may invoke (per-token cost varies wildly).
- **Shard by trust zone.** Copilot's plan-segmented hostnames are the sharding dial: default
  to one shared gateway, reserve a dedicated proxy for high-isolation tenants.

**Where we're harder than Copilot — and where the real safety net is.** Copilot owns both
ends (its own provider keys; the tenant boundary is *logical*). We broker into a cloud
provider on behalf of **mutually-distrusting tenants** — the privilege the gateway wields is
the *tenants' own* AWS privilege, so a gateway compromise is cross-tenant escalation in
*their* AWS. Strictly harder. But it hands us a **structural** boundary Copilot lacks:
tighten each tenant role's trust to **only the gateway principal**, scope it to **that
tenant's own inference profile** (the controller knows the profile id post-create), and mint
**short-lived per-request assumed sessions** holding no standing key. Then even a
fully-compromised gateway can only do what each individual request authorises. **The
per-tenant IAM scoping — not the gateway's good behaviour — is the real safety net.**

## Relationship

Promotes the gateway of [ADR-0004](0004-cost-governance.md) from the in-process decorator
of [ADR-0013](0013-inference-cost-enforcement.md) to a standalone, externally-reachable
service. Hardens the identity of [ADR-0014](0014-per-tenant-workload-identity.md) (drop
the wildcard) and adds a real `Authenticator` adapter to the split of
[ADR-0015](0015-split-authn-authz-ports.md) (verified OIDC, retiring `mesh-trust` as the
trust root). Composes with OBO ([0016](0016-obo-token-vault.md)/[0017](0017-a2a-identity-propagation.md))
for the human→agent path. Builds on the field-trip findings (commits `b7f2871`,
`ef3830f`): `sts:TagSession` on the keyless chain, and account-level model access vs the
per-tenant invoke grant. **Sandbox** (priority #3) is a forthcoming ADR.

## Sources

- LiteLLM — [Budgets & Rate Limits](https://docs.litellm.ai/docs/proxy/users), [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)
- Amazon Bedrock AgentCore Payments (preview, 2026-05-07) — [overview](https://dev.to/aicryptosystems/amazon-bedrock-agentcore-payments-the-spending-limit-is-the-product-obh)
- Bedrock usage limiting is monitoring-only — [AWS re:Post](https://repost.aws/articles/ARoDnASCxDQyGFfaagReMZNw/how-to-track-and-limit-amazon-bedrock-usage-by-user)
- AI gateway landscape 2026 — [TrueFoundry guide](https://www.truefoundry.com/blog/a-definitive-guide-to-ai-gateways-in-2026-competitive-landscape-comparison), [Kong benchmark](https://konghq.com/blog/engineering/ai-gateway-benchmark-kong-ai-gateway-portkey-litellm)
