/**
 * ClaimSource (ADR-0021) — where a tenant's inference *grant* comes from. With the gateway
 * (ADR-0019) a tenant needs no AWS provisioned, just a claim: identity → tenant + budget
 * (+ model). This is the read seam; behind it sits a Kubernetes CRD today (KubeClaimSource)
 * and a DynamoDB/API source for non-k8s tenants later — the gateway doesn't care which.
 *
 * It unifies the two lookups the gate + authn used to do separately: resolve a verified
 * ServiceAccount → its claim (authn), and a tenant → its claim (budget). So one adapter,
 * one read, satisfies both BudgetSource (limitFor) and the authn SaTenantResolver (tenantFor).
 */
export interface InferenceClaim {
  /** the tenant this grant belongs to. */
  tenant: string;
  /** the workload identity (verified SA) authorized for the tenant, if bound by identity. */
  serviceAccount?: string;
  /** requested model (a catalog alias) — carried for routing/enforcement (ADR-0021 follow-up). */
  model?: string;
  /** monthly spend cap (USD). */
  monthlyBudgetUsd?: number;
  /** per-session cap (USD) — the runaway-session stop. */
  sessionBudgetUsd?: number;
}

/** The CRD the claim is read from (group/version/plural + scope). Namespaced claims are the
 *  self-service shape (ADR-0021): tenant = the claim's namespace, so a tenant can only grant
 *  identities in its own namespace. Cluster-scoped is the legacy TenantInferenceProfile. */
export interface ClaimCrd {
  group?: string;
  version?: string;
  plural?: string;
  /** "Namespaced" ⇒ tenant = the claim's namespace; "Cluster" (default) ⇒ tenant = spec.tenant. */
  scope?: "Namespaced" | "Cluster";
}

export interface ClaimSource {
  readonly name: string;
  /** Resolve a verified ServiceAccount identity → its claim (authn → tenant + grant). */
  forServiceAccount(serviceAccount: string): Promise<InferenceClaim | undefined>;
  /** Resolve a tenant → its claim (budget lookup). */
  forTenant(tenant: string): Promise<InferenceClaim | undefined>;
}

/** The bound a self-service claim must fit within (the k8s VAP's params, as plain data). */
export interface Allowance {
  maxMonthlyUsd: number;
  allowedModels: string[];
}

/** The pieces the `POST /claims` self-service write needs (assembled by config, used by the
 *  gateway). verifyIdentity → the verified identity (tenant = it, 1:1); the claim is bounded by
 *  `allowance` and persisted by `putClaim`. */
export interface ClaimWrite {
  verifyIdentity: (token: string) => Promise<string | undefined>;
  allowance: Allowance;
  putClaim: (claim: InferenceClaim) => Promise<void>;
}

/**
 * Validate a claim against an allowance — the TS equivalent of the k8s CEL + VAP rules
 * (ADR-0021), used by the `POST /claims` write path (no API server to enforce there). Returns
 * the first failure, or ok. Mirrors: numeric budget, session ≤ monthly, budget ≤ cap, model allowed.
 */
export function validateClaim(claim: InferenceClaim, allowance: Allowance): { ok: boolean; reason?: string } {
  if (typeof claim.monthlyBudgetUsd !== "number" || !Number.isFinite(claim.monthlyBudgetUsd) || claim.monthlyBudgetUsd < 0)
    return { ok: false, reason: "monthlyBudgetUsd must be a non-negative number" };
  if (claim.sessionBudgetUsd != null && claim.sessionBudgetUsd > claim.monthlyBudgetUsd)
    return { ok: false, reason: "sessionBudgetUsd must not exceed monthlyBudgetUsd" };
  if (!claim.model) return { ok: false, reason: "model is required" };
  if (claim.monthlyBudgetUsd > allowance.maxMonthlyUsd)
    return { ok: false, reason: `monthlyBudgetUsd ${claim.monthlyBudgetUsd} exceeds the allowance max ${allowance.maxMonthlyUsd}` };
  if (!allowance.allowedModels.includes(claim.model))
    return { ok: false, reason: `model '${claim.model}' is not in the allowed models [${allowance.allowedModels.join(", ")}]` };
  return { ok: true };
}
