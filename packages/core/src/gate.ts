/**
 * Gate — the identity & governance control (ADR-0009). The L1 runtime applies it
 * around every run: authenticate the caller to a Principal (tenant + subject —
 * the two identities an agent action carries), then enforce a per-tenant budget.
 *
 * Thin by design: the LocalGate adapter (static tokens + in-memory budget) proves
 * the seam; managed swap-ins (AgentCore Identity / Auth0 Token Vault for the
 * human×agent token + downstream creds; AI gateway / Bedrock inference profiles +
 * AWS Budgets for spend; Cedar/OPA for policy) drop in behind this port.
 */
import type { TokenUsage } from "./ports";

/**
 * Who a run acts as. `tenant` is the multi-tenancy boundary (team/org); `subject`
 * is the human/service it acts on behalf of. The agent identity is the runtime
 * itself; the human×agent token that cryptographically binds both is a
 * managed-adapter concern (ADR-0009).
 */
export interface Principal {
  tenant: string;
  subject: string;
  /** Coarse group/role claims (from the verified token), if any — input to authz. */
  groups?: string[];
  /** The caller's inbound token (the subject_token), when available — the material
   *  an OBO broker exchanges for downstream creds that act AS the user (ADR-0010). */
  token?: string;
  /** The agent delegation chain on an agent-to-agent call (the nested `act` claim),
   *  most-recent actor first — `subject` stays the human. So at any hop the gate
   *  knows who is calling AND the full path of agents acting for the user (ADR-0017). */
  actors?: string[];
}

export interface BudgetStatus {
  tenant: string;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  ok: boolean;
}

/** Per-period RUN quota status (ADR-0036/0037) — the admission-time R2-equivalent for
 *  subscription/foreign-L1 runs, where a dollar budget is meaningless so the scarce
 *  resource is runs, not spend. `limit === Infinity` ⇒ quota disabled (unconfigured). */
export interface QuotaStatus {
  tenant: string;
  limit: number;
  used: number;
  remaining: number;
  ok: boolean;
}

export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(public readonly status: BudgetStatus) {
    super(`budget exceeded for tenant '${status.tenant}': $${status.spentUsd.toFixed(4)} / $${status.limitUsd}`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Gate — narrowed to **budget governance** (ADR-0015 split authn/authz out). One
 * specialized, quantitative policy: is the tenant within its (durable, monthly) cap?
 * Authentication is the `Authenticator` port; allow/deny policy is `Authorizer`.
 */
/** Optional extra budget scopes a reservation is checked against (ADR-0019). */
export interface BudgetScopes {
  /** A run/session id — caps spend for a single uninterrupted session (the runaway stop). */
  sessionId?: string;
}

export interface Gate {
  readonly name: string;
  /** Pre-flight: is the tenant within budget? (read-only, coarse — e.g. run admission) */
  checkBudget(tenant: string): Promise<BudgetStatus>;
  /** Record spend for a tenant (e.g. costed from inference usage). */
  recordSpend(tenant: string, usd: number): Promise<BudgetStatus>;
  /**
   * ATOMICALLY reserve `worstUsd` against every applicable scope (tenant/month, and
   * `sessionId` if given + a session cap is configured). Returns ok=false (and holds no
   * spend) if ANY scope would be breached — closing the check-then-add race (ADR-0019).
   * Pair with `settle` to reconcile the reservation to the actual cost.
   */
  reserve(tenant: string, worstUsd: number, scopes?: BudgetScopes): Promise<BudgetStatus>;
  /** Reconcile a prior reservation: add `deltaUsd` (actual − reserved, usually negative) to
   *  the same scopes. A fully-negative `deltaUsd` refunds a failed call. */
  settle(tenant: string, deltaUsd: number, scopes?: BudgetScopes): Promise<void>;
  /**
   * Atomically reserve ONE run against the tenant's per-period run quota — the
   * admission-time control for subscription/foreign-L1 runs (ADR-0036/0037), where
   * dollars are meaningless so the metered thing is *runs*. ok=false and no
   * reservation when the quota is exhausted. Unconfigured quota ⇒ always ok.
   */
  reserveRun(tenant: string): Promise<QuotaStatus>;
  /** Release a run reservation — e.g. the run failed to dispatch and never launched. */
  refundRun(tenant: string): Promise<void>;
  /**
   * Read-only: the tenant's run-quota status for the current period WITHOUT reserving
   * — the showback mirror of `checkBudget` for the subscription/foreign-L1 lane
   * (ADR-0036). `used` counts claude-code runs admitted this period. Unconfigured
   * quota ⇒ unlimited/ok.
   */
  checkQuota(tenant: string): Promise<QuotaStatus>;
}

// --- authn: who is the caller? (ADR-0015) -----------------------------------
/** What the authenticator sees: a bearer credential and/or request headers (where
 *  a mesh/IAP edge forwards verified identity). Neutral — no web types. */
export interface AuthnContext {
  credential?: string;
  /** Request headers, lowercased keys. */
  headers: Record<string, string | undefined>;
}

/** Resolve the caller to a Principal, or throw UnauthorizedError. Swappable per
 *  stack: static tokens (dev), mesh/IAP-propagated claims (prod), OIDC, … */
export interface Authenticator {
  readonly name: string;
  authenticate(ctx: AuthnContext): Promise<Principal>;
}

// --- authz: may this principal do this? (ADR-0015) --------------------------
export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

/** The allow/deny policy seam — identity + action(+resource) → decision. Stubbed
 *  by AllowAllAuthorizer today; OpaAuthorizer (query OPA) is the real swap-in.
 *  `attributes` carries additional resource context for the decision (e.g. the
 *  target repo of a claude-code run, ADR-0034 refinement) — policy data, so it
 *  belongs HERE, not on the AgentSpec: the agent is what runs, authz is what's
 *  allowed. */
export interface Authorizer {
  readonly name: string;
  authorize(
    principal: Principal,
    action: string,
    resource?: string,
    attributes?: Record<string, unknown>,
  ): Promise<PolicyDecision>;
}

/**
 * Where a tenant's spend cap comes from — factored out of the gate so the *limit*
 * and the *spend counter* are separate concerns. A flat env value is one source;
 * the real one is the Crossplane `TenantInferenceProfile` claim's `monthlyBudgetUsd`
 * (KubeBudgetSource), so the cap is declared once, per tenant, not maintained twice.
 * Returns `undefined` when it has no opinion for a tenant — the gate then falls back
 * to its default. (NB: this sources the *limit*; the spend *window* — monthly reset,
 * restart-durability — is the durable-gate concern, ADR-0009.)
 */
export interface BudgetSource {
  readonly name: string;
  limitFor(tenant: string): Promise<number | undefined>;
}

/**
 * Where a tenant's *spend* is tallied — factored out so the counter can be durable
 * and time-windowed independently of the gate. Spend is keyed by tenant + a billing
 * `period` (e.g. "2026-05"); a new month is simply a new key, so the monthly budget
 * resets with no cron. The in-memory default loses spend on restart; DynamoSpendStore
 * survives it with an atomic counter. (Closes the spend-*window* half of ADR-0013 —
 * the limit half is BudgetSource.)
 */
export interface SpendStore {
  readonly name: string;
  /** Total spend recorded for a tenant in a period. */
  get(tenant: string, period: string): Promise<number>;
  /** Atomically add spend; returns the new running total for that period. */
  add(tenant: string, period: string, usd: number): Promise<number>;
  /**
   * ATOMICALLY add `delta` iff the resulting total stays `<= ceiling`; returns the new
   * total, or `null` if it would breach (no change made). The conditional + add happen as
   * ONE operation, so concurrent callers can't both pass a read and then both add past the
   * cap (ADR-0019). Callers pre-check `delta <= ceiling` so the first-write case is safe.
   */
  reserve(tenant: string, period: string, delta: number, ceiling: number): Promise<number | null>;
}

/** The current monthly billing period as "YYYY-MM" (UTC). The budget window. */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Default SpendStore: in-process, per (tenant, period). Spend is lost on restart —
 *  swap DynamoSpendStore for durability. */
export class InMemorySpendStore implements SpendStore {
  readonly name = "memory";
  private readonly totals = new Map<string, number>();
  private key(tenant: string, period: string) {
    return `${tenant} ${period}`;
  }
  async get(tenant: string, period: string): Promise<number> {
    return this.totals.get(this.key(tenant, period)) ?? 0;
  }
  async add(tenant: string, period: string, usd: number): Promise<number> {
    const next = (this.totals.get(this.key(tenant, period)) ?? 0) + usd;
    this.totals.set(this.key(tenant, period), next);
    return next;
  }
  async reserve(tenant: string, period: string, delta: number, ceiling: number): Promise<number | null> {
    // single-threaded JS: read-and-set is atomic by construction here
    const next = (this.totals.get(this.key(tenant, period)) ?? 0) + delta;
    if (next > ceiling) return null;
    this.totals.set(this.key(tenant, period), next);
    return next;
  }
}

/**
 * Rough $/token by model (per 1M tokens) — enough for a POC budget counter. Swap
 * for an AI gateway / Bedrock cost data in prod (ADR-0009).
 */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "amazon.nova-lite-v1:0": { in: 0.06, out: 0.24 },
  "amazon.nova-pro-v1:0": { in: 0.8, out: 3.2 },
  // Anthropic on Bedrock — substring keys, so any regional/dated id form matches
  // ("eu.anthropic.claude-haiku-4-5-20251001-v1:0" etc.). Mirror of admission_hook.py.
  "claude-haiku": { in: 1.0, out: 5.0 },
  "claude-sonnet": { in: 3.0, out: 15.0 },
  // Gemini on Vertex (GCP profile, ADR-0044) — substring keys match any dated form.
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10.0 },
  default: { in: 0.5, out: 1.5 },
};

/** Price a known input/output token split in USD. Shared by the actual-cost
 *  estimate (post-call) and the worst-case admission check (pre-call, ADR-0013).
 *  Exact key first, then substring (covers Bedrock's regional/dated model ids). */
export function priceTokensUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p =
    PRICE_PER_MTOK[model] ??
    Object.entries(PRICE_PER_MTOK).find(([k]) => k !== "default" && model.includes(k))?.[1] ??
    PRICE_PER_MTOK.default!;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/** Estimate USD cost of a turn/run from observed token usage. */
export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  return priceTokensUsd(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
}
