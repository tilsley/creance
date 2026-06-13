# ADR-0013: Inference cost enforcement — buy the gateway, own the admission policy

- **Status:** Proposed — the *buy the gateway (engine)* half is reversed by [0028](0028-own-the-gateway-engine.md); the *own the admission policy* half (worst-case pre-flight reserve) carries over verbatim into the owned engine
- **Date:** 2026-05-28

## Context

[ADR-0004](0004-cost-governance.md) decided the *split*: attribution (Bedrock
application inference profiles + tags + AWS Budgets, lagging) vs enforcement (an
in-path gateway that meters in real time and rejects at the cap). We have now
**built the attribution half** — the `TenantInferenceProfile` claim provisions a
tagged profile + a scoped IAM policy + a tag-filtered AWS Budget
([crossplane composition](../../deploy/local/crossplane/tenant-composition.yaml)),
and confirmed the tag flows to Cost Explorer. ADR-0004 left the *enforcement* half
as "the gateway computes tokens × price and rejects." This ADR answers the two
questions that abstraction hid:

1. **Build or buy the gateway?** It's a crowded category — reinventing it is waste.
2. **What admission model actually stops a single $50 one-shot prompt?** Post-hoc
   spend accounting can't: the dollars are gone before `recordSpend` runs.

The trigger was realising the `InferenceProvider` port
([ports.ts](../../packages/core/src/ports.ts)) — the one chokepoint every model
call already funnels through — has **no `maxTokens`**, so output cost is currently
*unbounded*. That is the concrete hole.

## Landscape (verified May 2026)

| Tool | Form | Cost control | Admission model |
|---|---|---|---|
| [LiteLLM Proxy](https://docs.litellm.ai/docs/proxy/users) | self-host proxy, OpenAI-compatible, Bedrock | per key/user/team/tag `max_budget` + `budget_duration`, TPM/RPM | pre-call check of **accumulated** spend in the auth chain; bounds a single call only via `max_tokens`. Note: documented **fail-open** budget bugs ([#27480](https://github.com/BerriAI/litellm/issues/27480), [#12905](https://github.com/BerriAI/litellm/issues/12905)) |
| [Portkey](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits) | proxy / managed | virtual-key USD cap (expires key) + max-token cap, RPM/TPM, model allow-list, workspace budgets | accumulated cap; **budget limits are Enterprise-only** |
| [Envoy AI Gateway](https://aigateway.envoyproxy.io/docs/capabilities/) | k8s data plane (CNCF/Tetrate/Bloomberg) | token-based rate limiting, custom token cost via CEL; Bedrock + OpenAI; v0.6 API at `v1beta1` | **token** rate limit, not a dollar cap |
| [Azure APIM `llm-token-limit`](https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy) | managed gateway policy | TPM + token quota (hourly→yearly) per key | **pre-emptive: estimates prompt tokens *before* the backend call** and rejects (429 rate / 403 quota) — closest to worst-case pre-auth, in token space |
| [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) | managed edge | cost **tracking** + custom pricing, rate limiting (free core) | observability + rate limit; **no hierarchical budgets / virtual keys / RBAC** |
| [Bedrock app inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-application-inference-profiles.html) | AWS-native | tagged wrapper → Cost Explorer / CUR 2.0 | **none** — "AWS does not provide native IAM policies to limit Bedrock API calls or token consumption… monitoring and alerting, not native caps" ([re:Post](https://repost.aws/articles/ARoDnASCxDQyGFfaagReMZNw/how-to-track-and-limit-amazon-bedrock-usage-by-user)) |
| [AWS Budget Actions](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html) | AWS-native | auto-apply Deny IAM policy / SCP / stop EC2-RDS at threshold | **enforceable but lagging** (billing data refreshes hours-late) |

Two honest takeaways:

- **The gateway is not novel and pre-emptive estimation is not novel.** Azure APIM
  already estimates prompt tokens before the backend call. Our "worst-case dollar
  admission" is the **dollar-space variant** of the same idea, not an invention.
- **Bedrock has zero native admission control** (confirmed in writing). On AWS, a
  hard per-tenant cap *must* be added in-path — inference profiles are metering only.

## Decision

**Buy the gateway, own the admission policy.** Concretely:

- **Keep `InferenceProvider` as the seam.** Don't build a production gateway. For
  real, implement the port with a **self-hosted LiteLLM** adapter (OpenAI-compatible,
  first-class Bedrock, per-team budgets) — the proxy *is* how the port gets
  implemented, enforced with IAM so only the proxy's role holds `bedrock:InvokeModel`
  and agents get none ([ADR-0009](0009-gate-identity-and-governance.md) principal).
- **Add `maxTokens` to the port first.** Unbounded output = unbounded cost. An
  uncapped request must be *refused*, not sent.
- **Admission = worst-case, pre-flight.** Price the request's upper bound before
  sending and reject if it exceeds the tenant's remaining budget:
  `(count(input_tokens) × in_price) + (maxTokens × out_price) ≤ remaining`. This is
  what stops the $50 one-shot on the *first* call — accumulation-only gates (LiteLLM,
  Portkey) would let it through and block only the *next* one. Build it as a thin
  **decorator over the port** for the POC (lowest latency, a clean learning artifact);
  it later moves into the proxy as a custom pre-call hook. Same logic, relocated.
- **Durable per-tenant counter** behind admission: atomic increment (DynamoDB
  `ADD spentUsd`), keyed `(tenant, yyyy-mm)` so it resets monthly. The limit is the
  **claim's `monthlyBudgetUsd`** — the *same* number that feeds the AWS Budget. One
  spec, two consumers (the principle ADR-0004 set, now with a real source field).
- **AWS Budget Action as backstop, not primary.** Extend the Crossplane composition
  with a `budgetactions` MR that attaches a Deny policy to the tenant principal on
  breach — catches spend that bypassed the gateway (leaked creds → Bedrock direct).
  Coarse and lagging by design; defense-in-depth.

```
1. ADMISSION (InferenceProvider decorator → later LiteLLM hook)   worst-case $ ≤ remaining   ← the hard stop
2. DURABLE COUNTER (gate, DynamoDB, per-tenant/month)             atomic actual spend
3. AWS BUDGET ACTION                                             billing-layer backstop, off-path
```

## Consequences

- **+** No hand-rolled gateway; the port lets us swap LiteLLM/Portkey/Envoy without
  touching `loop.ts`. The differentiated bit (worst-case dollar admission) is small,
  portable, and the sharpest control in the table.
- **+** Closes the $50-one-shot hole that ADR-0004's "tokens × price" framing didn't
  name. Bounds cost *before* spend, not after.
- **−** Worst-case admission is conservative: it reserves `maxTokens` of output cost
  even if the actual response is short, so it can refuse a request that *would* have
  fit. True pre-auth with reservation/refund is the upgrade; acceptable for a POC.
- **−** An in-flight run can still overshoot slightly (cost known only after a turn);
  the cap bites on the *next* request. The dollar-exact gate is the runtime control;
  the AWS Budget Action is the slow authoritative backstop — two timescales.
- **−** If/when we adopt LiteLLM, track its fail-open budget bugs (cited above) — a
  budget that silently stops enforcing is worse than none.

## Relationship

Refines the **enforcement** half of [ADR-0004](0004-cost-governance.md) (which chose
the attribution/enforcement split and the single-source cap) with a build-vs-buy
survey and the admission model. Implements the spend control of
[ADR-0009](0009-gate-identity-and-governance.md) behind the `InferenceProvider` port
([ADR-0003](0003-ports-and-adapters.md)). The per-tenant limit is sourced from the
`TenantInferenceProfile` claim ([ADR-0005](0005-crossplane-control-plane.md)).
