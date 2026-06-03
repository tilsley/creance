# ADR-0025: Cost allocation lives in the gateway's ledger, not in per-tenant Bedrock profiles

- **Status:** Proposed (refines the attribution half of [0004](0004-cost-governance.md); walks back the per-tenant-profile chargeback assumption carried in [0013](0013-inference-cost-enforcement.md)/[0021](0021-inference-onboarding-policy.md); sits behind [0024](0024-build-vs-buy-managed-agent-platforms.md))
- **Date:** 2026-06-03

## Context

[ADR-0004](0004-cost-governance.md) split cost governance into **attribution** (Bedrock
application inference profiles + cost-allocation tags → Cost Explorer / CUR, lagging) and
**enforcement** (the in-path gateway, real-time). The enforcement half is built and hardened
([0013](0013-inference-cost-enforcement.md)/[0019](0019-inference-gateway.md)). The attribution
half carried an unexamined assumption: that **per-tenant cost allocation = a tagged Bedrock
application inference profile per tenant/app**.

Followed literally, that means **tens of inference profiles** — one per application — each a
provisioned, tagged, lifecycle-managed AWS object, created on every onboarding. That is the exact
provisioning-proliferation [0021](0021-inference-onboarding-policy.md) set out to kill on the
*enforcement* path; it was never re-examined on the *attribution* path.

Two later decisions dissolve the assumption:

- **The gateway sees every call with a verified identity** ([0019](0019-inference-gateway.md)).
  It already knows *who* spent *what*, in real time — so attribution doesn't need an AWS object per
  tenant; it needs a *ledger keyed by identity*.
- **We buy the proxy engine** ([0024](0024-build-vs-buy-managed-agent-platforms.md)) — LiteLLM
  behind the `InferenceProvider` port. Its native model is **teams → keys → users**, each with spend
  tracked in its own Postgres-backed ledger. Org structure is a *software* construct, not an AWS one.

So the real question is no longer *"how do we provision a profile per app?"* but *"where do the
cost/identity buckets live?"* — and the answer is **in the gateway's ledger, not in IAM.**

## Decision

**Model teams / services / users as buckets in the gateway's ledger behind one shared AWS
footprint. Per-tenant Bedrock inference profiles become opt-in — only for AWS-invoice-level
chargeback, never the default attribution mechanism.**

1. **One AWS footprint, done once.** A single IAM role (IRSA on the proxy) holds
   `bedrock:InvokeModel`; one (or a few cross-region) **shared** inference profiles serve all
   callers. No per-app / per-tenant AWS objects, no profile created per onboarding. The painful
   IAM/Bedrock setup is a one-time shared cost (consistent with [0021](0021-inference-onboarding-policy.md)'s
   "per-tenant AWS is opt-in").
2. **Buckets are software.** A cost/identity bucket = a **LiteLLM team / virtual key / user**
   (Postgres-backed), not an AWS resource. *"My service in k8s"* and *"my app on my laptop"* are
   simply two keys against the same pipe — one IAM role, two buckets.
3. **One gateway, every origin.** Calls from a dev laptop and from k8s hit the **same** gateway;
   the only difference is which credential they present, and that credential *is* the bucket
   selector. Developers hold no AWS creds — they hold a budget-capped, rate-limited, **revocable**
   key (a leaked key is a contained, cheap incident; a leaked AWS key is not).
4. **The ledger is the attribution source of truth.** The post-call settle keys actual spend by
   `(bucket, month)` in the **SpendStore** ([Postgres, 0023](0023-memory-backends-postgres-redis.md));
   read in the proxy UI or exported to Prometheus/Langfuse. Real-time, per-call, finer-grained
   (per user/service) than AWS tags give.
5. **Per-tenant inference profiles are opt-in, invoice-only.** Keep the [0004](0004-cost-governance.md)
   tagged-profile mechanism *solely* where Finance needs the split to appear on the **AWS invoice**
   (CUR), or for penny-exact reconciliation — and even then a **platform controller** provisions it,
   never the tenant, never per onboarding.

**Identity nuance (don't lose the threat model).** Vanilla LiteLLM keys buckets on **virtual keys**
— leakable bearer secrets — which is fine for *trusted internal* teams and is what most orgs run.
The platform's stricter threat model maps the bucket onto a **verified** identity (the
`user_api_key_auth` hook anchoring LiteLLM's team to the SA/IAM token — [0019](0019-inference-gateway.md)/[0024](0024-build-vs-buy-managed-agent-platforms.md)),
so the bucket can't be spoofed and the worst-case pre-flight hard-stop (R2) overrides LiteLLM's
accumulation-only budgets. **Same bucket model, hardened anchor** — add the hardening when tenants
are untrusted (agents), not before.

## Consequences

- **+** Onboarding an app/team/user = create a key in software — no AWS provisioning, no profile
  lifecycle. The tens-of-profiles proliferation is gone.
- **+** One IAM setup, done once; no AWS creds on laptops; keys are capped + instantly revocable, so
  the blast radius of a leak is bounded by the bucket's budget.
- **+** Uniform path for local dev and prod — identical gateway, identical metering, differing only
  by key. The "develop locally vs run in k8s" split is just two buckets.
- **+** Real-time, per-bucket attribution from the ledger, more granular than cost-allocation tags
  easily allow (per user/service, not just per tenant).
- **−** The **AWS bill is one line**; the per-bucket split exists only in the ledger. Invoice-level
  chargeback requires opting back into tagged profiles + CUR.
- **−** Ledger cost is **computed** (`tokens × price map`), so it can drift from the actual AWS
  charge (stale prices, rounding, cache hits) — close enough for showback, not penny-exact to the
  invoice.
- **−** One shared role = **one shared Bedrock account quota** → noisy-neighbour at scale. Mitigate
  by carving per-bucket RPM/TPM (the proxy enforces it) and escalating high-isolation tenants to
  their own profile / Provisioned Throughput / AWS account ([0019](0019-inference-gateway.md)/[0021](0021-inference-onboarding-policy.md)).
- **−** Bucket integrity depends on the identity anchor: virtual keys are leakable (accept for
  trusted teams; harden with verified-identity mapping for untrusted/agent tenants).

## Relationship

Refines the **attribution** half of [ADR-0004](0004-cost-governance.md): the gateway ledger becomes
the default per-tenant cost-allocation mechanism, demoting tagged inference profiles to an opt-in,
invoice-only concern. Walks back the implicit *"a profile per tenant/app"* chargeback assumption
carried in [ADR-0013](0013-inference-cost-enforcement.md) and [ADR-0021](0021-inference-onboarding-policy.md)
(which already made per-tenant AWS opt-in for *isolation* — this extends the same logic to *cost*).
Realizes the SpendStore of [ADR-0023](0023-memory-backends-postgres-redis.md), sits behind the
buy-the-engine topology of [ADR-0024](0024-build-vs-buy-managed-agent-platforms.md), and is anchored
to the verified identity of [ADR-0019](0019-inference-gateway.md). One-liner: **AWS gives one capped,
role-secured pipe; the gateway turns it into as many cost/identity buckets as you want — in
software, not in IAM.**
