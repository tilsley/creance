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
}

export interface BudgetStatus {
  tenant: string;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
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

export interface Gate {
  readonly name: string;
  /** Resolve the caller's identity from a bearer credential, or throw UnauthorizedError. */
  authenticate(credential: string | undefined): Promise<Principal>;
  /** Pre-flight: is the tenant within budget? */
  checkBudget(tenant: string): Promise<BudgetStatus>;
  /** Record spend for a tenant (e.g. costed from inference usage). */
  recordSpend(tenant: string, usd: number): Promise<BudgetStatus>;
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
 * Rough $/token by model (per 1M tokens) — enough for a POC budget counter. Swap
 * for an AI gateway / Bedrock cost data in prod (ADR-0009).
 */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "amazon.nova-lite-v1:0": { in: 0.06, out: 0.24 },
  "amazon.nova-pro-v1:0": { in: 0.8, out: 3.2 },
  default: { in: 0.5, out: 1.5 },
};

/** Price a known input/output token split in USD. Shared by the actual-cost
 *  estimate (post-call) and the worst-case admission check (pre-call, ADR-0013). */
export function priceTokensUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK.default!;
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

/** Estimate USD cost of a turn/run from observed token usage. */
export function estimateCostUsd(model: string, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  return priceTokensUsd(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
}
