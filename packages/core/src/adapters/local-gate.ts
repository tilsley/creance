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
 * The per-tenant cap can come from a BudgetSource (e.g. the Crossplane claim's
 * monthlyBudgetUsd — KubeBudgetSource); GATE_BUDGET_USD is the fallback when the
 * source has no entry for a tenant. The in-memory spend counter is unchanged.
 */
import type { Gate, Principal, BudgetStatus, BudgetSource } from "../gate";
import { UnauthorizedError } from "../gate";

export class LocalGate implements Gate {
  readonly name = "local";
  private readonly principals = new Map<string, Principal>();
  private readonly fallbackLimitUsd: number;
  private readonly source?: BudgetSource;
  private readonly spent = new Map<string, number>();

  constructor(tokensSpec?: string, budgetUsd?: string, source?: BudgetSource) {
    for (const entry of (tokensSpec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const [token, tenant, subject] = entry.split(":");
      if (token && tenant) this.principals.set(token, { tenant, subject: subject ?? "unknown" });
    }
    this.fallbackLimitUsd = Number(budgetUsd ?? "1.00");
    this.source = source;
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

  /** The tenant's cap: from the BudgetSource if it has one, else the flat fallback. */
  private async limitFor(tenant: string): Promise<number> {
    const fromSource = await this.source?.limitFor(tenant);
    return fromSource != null && Number.isFinite(fromSource) ? fromSource : this.fallbackLimitUsd;
  }

  private async status(tenant: string): Promise<BudgetStatus> {
    const limitUsd = await this.limitFor(tenant);
    const spentUsd = this.spent.get(tenant) ?? 0;
    return { tenant, limitUsd, spentUsd, remainingUsd: limitUsd - spentUsd, ok: spentUsd < limitUsd };
  }
}
