/**
 * LocalGate — the thin local `gate` adapter (ADR-0009). Tokens map to principals
 * via env; budget is a per-tenant in-memory USD counter. For dev + proving the
 * seam, NOT production: static tokens, spend lost on restart, no real OBO / token
 * vault / policy engine. Swap for AgentCore Identity / Auth0 Token Vault + an AI
 * gateway.
 *
 *   GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob"   (token:tenant:subject)
 *   GATE_BUDGET_USD="1.00"                             (default cap; fallback)
 *
 * Composable: the per-tenant cap comes from a BudgetSource (e.g. the Crossplane
 * claim's monthlyBudgetUsd — KubeBudgetSource; GATE_BUDGET_USD is the fallback),
 * and spend is tallied through a SpendStore (in-memory by default, DynamoSpendStore
 * for restart-durable, monthly-windowed counting). The gate itself just wires
 * identity + the current period together.
 */
import type { Gate, Principal, BudgetStatus, BudgetSource, SpendStore } from "../gate";
import { UnauthorizedError, InMemorySpendStore, currentPeriod } from "../gate";

export interface LocalGateOptions {
  /** Per-tenant cap source; falls back to GATE_BUDGET_USD when it has no entry. */
  source?: BudgetSource;
  /** Spend tally backend; defaults to in-process (lost on restart). */
  spendStore?: SpendStore;
  /** Clock for the billing period — injectable so the monthly reset is testable. */
  now?: () => Date;
}

export class LocalGate implements Gate {
  readonly name = "local";
  private readonly principals = new Map<string, Principal>();
  private readonly fallbackLimitUsd: number;
  private readonly source?: BudgetSource;
  private readonly spend: SpendStore;
  private readonly now: () => Date;

  constructor(tokensSpec?: string, budgetUsd?: string, opts: LocalGateOptions = {}) {
    for (const entry of (tokensSpec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [token, tenant, subject] = entry.split(":");
      if (token && tenant) this.principals.set(token, { tenant, subject: subject ?? "unknown" });
    }
    this.fallbackLimitUsd = Number(budgetUsd ?? "1.00");
    this.source = opts.source;
    this.spend = opts.spendStore ?? new InMemorySpendStore();
    this.now = opts.now ?? (() => new Date());
  }

  async authenticate(credential: string | undefined): Promise<Principal> {
    const principal = credential ? this.principals.get(credential) : undefined;
    if (!principal) throw new UnauthorizedError();
    return principal;
  }

  async checkBudget(tenant: string): Promise<BudgetStatus> {
    const period = currentPeriod(this.now());
    return this.status(tenant, await this.spend.get(tenant, period));
  }

  async recordSpend(tenant: string, usd: number): Promise<BudgetStatus> {
    const period = currentPeriod(this.now());
    return this.status(tenant, await this.spend.add(tenant, period, usd));
  }

  /** The tenant's cap: from the BudgetSource if it has one, else the flat fallback. */
  private async limitFor(tenant: string): Promise<number> {
    const fromSource = await this.source?.limitFor(tenant);
    return fromSource != null && Number.isFinite(fromSource) ? fromSource : this.fallbackLimitUsd;
  }

  private async status(tenant: string, spentUsd: number): Promise<BudgetStatus> {
    const limitUsd = await this.limitFor(tenant);
    return { tenant, limitUsd, spentUsd, remainingUsd: limitUsd - spentUsd, ok: spentUsd < limitUsd };
  }
}
