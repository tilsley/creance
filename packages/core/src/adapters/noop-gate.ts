/**
 * NoopGate — open gate: no auth, no budget. The default, so examples and
 * dep-migrator (which call the loop directly) are unaffected. The runtime opts
 * into real identity via GATE=local (LocalGate). See ADR-0009.
 */
import type { Gate, Principal, BudgetStatus } from "../gate";

const unlimited = (tenant: string): BudgetStatus => ({
  tenant,
  limitUsd: Infinity,
  spentUsd: 0,
  remainingUsd: Infinity,
  ok: true,
});

export class NoopGate implements Gate {
  readonly name = "noop";
  async authenticate(): Promise<Principal> {
    return { tenant: "default", subject: "anonymous" };
  }
  async checkBudget(tenant: string): Promise<BudgetStatus> {
    return unlimited(tenant);
  }
  async recordSpend(tenant: string): Promise<BudgetStatus> {
    return unlimited(tenant);
  }
}
