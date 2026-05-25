/**
 * LocalGate — the thin local `gate` adapter (ADR-0009). Tokens map to principals
 * via env; budget is a per-tenant in-memory USD counter. For dev + proving the
 * seam, NOT production: static tokens, spend lost on restart, no real OBO / token
 * vault / policy engine. Swap for AgentCore Identity / Auth0 Token Vault + an AI
 * gateway.
 *
 *   GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob"   (token:tenant:subject)
 *   GATE_BUDGET_USD="1.00"                             (per tenant)
 */
import type { Gate, Principal, BudgetStatus } from "../gate";
import { UnauthorizedError } from "../gate";

export class LocalGate implements Gate {
  readonly name = "local";
  private readonly principals = new Map<string, Principal>();
  private readonly limitUsd: number;
  private readonly spent = new Map<string, number>();

  constructor(tokensSpec?: string, budgetUsd?: string) {
    for (const entry of (tokensSpec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [token, tenant, subject] = entry.split(":");
      if (token && tenant) this.principals.set(token, { tenant, subject: subject ?? "unknown" });
    }
    this.limitUsd = Number(budgetUsd ?? "1.00");
  }

  async authenticate(credential: string | undefined): Promise<Principal> {
    const principal = credential ? this.principals.get(credential) : undefined;
    if (!principal) throw new UnauthorizedError();
    return principal;
  }

  async checkBudget(tenant: string): Promise<BudgetStatus> {
    return this.status(tenant);
  }

  async recordSpend(tenant: string, usd: number): Promise<BudgetStatus> {
    this.spent.set(tenant, (this.spent.get(tenant) ?? 0) + usd);
    return this.status(tenant);
  }

  private status(tenant: string): BudgetStatus {
    const spentUsd = this.spent.get(tenant) ?? 0;
    return { tenant, limitUsd: this.limitUsd, spentUsd, remainingUsd: this.limitUsd - spentUsd, ok: spentUsd < this.limitUsd };
  }
}
