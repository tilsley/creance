/**
 * NoopGate — open **budget** gate: unlimited, no accounting. The default, so
 * examples and dep-migrator (which call the loop directly) are unaffected. The
 * runtime opts into real budgets via GATE=local (LocalGate). Identity is the
 * Authenticator port now (NoopAuthenticator is the open default). See ADR-0009/0015.
 */
import type { Gate, BudgetStatus, QuotaStatus } from "../gate";

const unlimited = (tenant: string): BudgetStatus => ({
  tenant,
  limitUsd: Infinity,
  spentUsd: 0,
  remainingUsd: Infinity,
  ok: true,
});

const unlimitedQuota = (tenant: string): QuotaStatus => ({
  tenant,
  limit: Infinity,
  used: 0,
  remaining: Infinity,
  ok: true,
});

export class NoopGate implements Gate {
  readonly name = "noop";
  async checkBudget(tenant: string): Promise<BudgetStatus> {
    return unlimited(tenant);
  }
  async recordSpend(tenant: string): Promise<BudgetStatus> {
    return unlimited(tenant);
  }
  async reserve(tenant: string): Promise<BudgetStatus> {
    return unlimited(tenant);
  }
  async settle(): Promise<void> {
    /* unlimited — nothing to reconcile */
  }
  async reserveRun(tenant: string): Promise<QuotaStatus> {
    return unlimitedQuota(tenant);
  }
  async refundRun(): Promise<void> {
    /* unlimited — no quota to release */
  }
}
