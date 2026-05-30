/**
 * LocalGate — the local **budget** gate (ADR-0009; authn/authz split out per
 * ADR-0015). A per-tenant USD counter: cap from a BudgetSource (the Crossplane
 * claim's monthlyBudgetUsd — KubeBudgetSource; GATE_BUDGET_USD is the fallback),
 * spend tallied through a SpendStore (in-memory by default, DynamoSpendStore for
 * restart-durable, monthly-windowed counting). Identity is the Authenticator port
 * now, not this gate.
 *
 *   GATE_BUDGET_USD="1.00"   (default cap; fallback when a tenant has no claim)
 */
import type { Gate, BudgetStatus, BudgetSource, SpendStore } from "../gate";
import { InMemorySpendStore, currentPeriod } from "../gate";

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
  private readonly fallbackLimitUsd: number;
  private readonly source?: BudgetSource;
  private readonly spend: SpendStore;
  private readonly now: () => Date;

  constructor(budgetUsd?: string, opts: LocalGateOptions = {}) {
    this.fallbackLimitUsd = Number(budgetUsd ?? "1.00");
    this.source = opts.source;
    this.spend = opts.spendStore ?? new InMemorySpendStore();
    this.now = opts.now ?? (() => new Date());
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
