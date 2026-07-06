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
import type { Gate, BudgetStatus, BudgetScopes, BudgetSource, QuotaStatus, SpendStore } from "../gate";
import { InMemorySpendStore, currentPeriod } from "../gate";

export interface LocalGateOptions {
  /** Per-tenant cap source; falls back to GATE_BUDGET_USD when it has no entry. */
  source?: BudgetSource;
  /** Spend tally backend; defaults to in-process (lost on restart). */
  spendStore?: SpendStore;
  /** Clock for the billing period — injectable so the monthly reset is testable. */
  now?: () => Date;
  /** Per-session cap (USD) — the runaway-session stop (ADR-0019). Undefined ⇒ session
   *  scope off (only the tenant/month cap is enforced). */
  sessionLimitUsd?: number;
  /** Per-tenant runs-per-period quota (ADR-0036/0037) — the R2-equivalent for
   *  subscription/foreign-L1 runs. Undefined ⇒ quota off (reserveRun always ok).
   *  Counted through the SAME SpendStore in a `runs#<period>` namespace, so it
   *  inherits the atomic conditional-add + monthly reset for free. */
  runQuota?: number;
}

export class LocalGate implements Gate {
  readonly name = "local";
  private readonly fallbackLimitUsd: number;
  private readonly source?: BudgetSource;
  private readonly spend: SpendStore;
  private readonly now: () => Date;
  private readonly sessionLimitUsd?: number;
  private readonly runQuota?: number;

  constructor(budgetUsd?: string, opts: LocalGateOptions = {}) {
    this.fallbackLimitUsd = Number(budgetUsd ?? "1.00");
    this.source = opts.source;
    this.spend = opts.spendStore ?? new InMemorySpendStore();
    this.now = opts.now ?? (() => new Date());
    this.sessionLimitUsd = opts.sessionLimitUsd;
    this.runQuota = opts.runQuota;
  }

  /** Run-quota period key — a `runs#` namespace on the SAME store, so run counts and
   *  dollar spend never collide and both reset monthly by key rotation. */
  private runPeriod(): string {
    return `runs#${currentPeriod(this.now())}`;
  }

  async reserveRun(tenant: string): Promise<QuotaStatus> {
    const limit = this.runQuota;
    if (limit == null) return { tenant, limit: Infinity, used: 0, remaining: Infinity, ok: true }; // off
    // delta is always 1, so a limit < 1 can never fit — refuse without touching the store
    // (mirrors the reserve pre-check; also keeps DynamoSpendStore's first-write path safe).
    if (limit < 1) return { tenant, limit, used: await this.spend.get(tenant, this.runPeriod()), remaining: 0, ok: false };
    const total = await this.spend.reserve(tenant, this.runPeriod(), 1, limit);
    if (total == null) {
      const used = await this.spend.get(tenant, this.runPeriod());
      return { tenant, limit, used, remaining: Math.max(0, limit - used), ok: false };
    }
    return { tenant, limit, used: total, remaining: limit - total, ok: true };
  }

  async refundRun(tenant: string): Promise<void> {
    if (this.runQuota == null) return;
    await this.spend.add(tenant, this.runPeriod(), -1);
  }

  async checkBudget(tenant: string): Promise<BudgetStatus> {
    const period = currentPeriod(this.now());
    return this.status(tenant, await this.spend.get(tenant, period));
  }

  async recordSpend(tenant: string, usd: number): Promise<BudgetStatus> {
    const period = currentPeriod(this.now());
    return this.status(tenant, await this.spend.add(tenant, period, usd));
  }

  /** Whether the per-session scope is active for this reservation. */
  private sessionOn(scopes?: BudgetScopes): scopes is { sessionId: string } {
    return this.sessionLimitUsd != null && !!scopes?.sessionId;
  }
  private sessionKey(sessionId: string): string {
    return `session#${sessionId}`;
  }

  async reserve(tenant: string, worstUsd: number, scopes?: BudgetScopes): Promise<BudgetStatus> {
    const period = currentPeriod(this.now());
    const tenantCap = await this.limitFor(tenant);
    // single request bigger than the whole cap can never fit
    if (worstUsd > tenantCap) return this.overBy(tenant, tenantCap, await this.spend.get(tenant, period), worstUsd);

    // atomic reserve against tenant/month
    const tenantTotal = await this.spend.reserve(tenant, period, worstUsd, tenantCap);
    if (tenantTotal == null) return this.overBy(tenant, tenantCap, await this.spend.get(tenant, period), worstUsd);

    // then the session scope (if active) — refund the tenant reserve if it doesn't fit
    if (this.sessionOn(scopes)) {
      const cap = this.sessionLimitUsd!;
      const key = this.sessionKey(scopes.sessionId);
      const sessionTotal = worstUsd > cap ? null : await this.spend.reserve(tenant, key, worstUsd, cap);
      if (sessionTotal == null) {
        await this.spend.add(tenant, period, -worstUsd); // refund tenant — nothing admitted
        return this.overBy(tenant, cap, await this.spend.get(tenant, key), worstUsd);
      }
    }
    return { tenant, limitUsd: tenantCap, spentUsd: tenantTotal, remainingUsd: tenantCap - tenantTotal, ok: true };
  }

  async settle(tenant: string, deltaUsd: number, scopes?: BudgetScopes): Promise<void> {
    const period = currentPeriod(this.now());
    await this.spend.add(tenant, period, deltaUsd);
    if (this.sessionOn(scopes)) await this.spend.add(tenant, this.sessionKey(scopes.sessionId), deltaUsd);
  }

  /** A failing-scope BudgetStatus (ok:false) reporting the projected over-cap spend. */
  private overBy(tenant: string, limitUsd: number, current: number, worstUsd: number): BudgetStatus {
    const spentUsd = current + worstUsd;
    return { tenant, limitUsd, spentUsd, remainingUsd: limitUsd - spentUsd, ok: false };
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
