# ADR-0004: Cost governance — attribution vs. enforcement

- **Status:** Accepted
- **Date:** 2026-05-23

## Context

We need per-team inference cost **separation** and hard **caps** ("team foo: max
$50/day"). AWS billing data lags hours, so it can't enforce a real-time cap.

## Decision

Split cost governance into **attribution** (AWS-native, after-the-fact) and
**enforcement** (in-path, real-time):

- **Attribution.** Per-team **Bedrock application inference profiles**, tagged →
  per-team spend in Cost Explorer / CUR and per-profile CloudWatch token/
  invocation metrics. Layer these on **cross-region inference profiles**
  underneath for throughput and model access (some Claude models on Bedrock are
  only invocable via an inference-profile id).
- **Enforcement.** The **inference-gateway** computes `tokens × price` per call,
  keeps a real-time "spent today" counter (Redis/ElastiCache), and rejects /
  throttles at the limit. **AWS Budgets only alerts (delayed)** — it cannot hard-
  stop, so the cap must live in-path.
- **One declarative source.** The per-team cap is expressed once in the
  `InferenceProfile` CRD as `spec.parameters.maxDailyCostUSD` (see
  [ADR-0005](0005-crossplane-control-plane.md)). Crossplane provisions the tagged
  profile + an AWS Budget from it; the gateway reads the same value to enforce in
  real time. One spec, two consumers.
- **Compute** follows the same shape: sandbox-manager enforces compute budgets.

## Consequences

- Hard caps require the gateway in the request path (a deliberate choke point).
- Bedrock profiles/tags are authoritative but lag; reconcile the gateway counter
  against billing periodically.
- "Only way to separate costing?" No — alternatives are separate AWS accounts
  per team (heaviest) or pure gateway metering (provider-agnostic). We use
  application profiles (native attribution) **plus** gateway metering
  (real-time + enforcement).
