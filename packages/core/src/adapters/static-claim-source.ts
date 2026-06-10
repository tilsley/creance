/**
 * StaticClaimSource — claims from an env JSON map (dev/test, no k8s, no AWS). The TS
 * mirror of the LiteLLM hook's CLAIMS_STATIC, same shape, so both gateways can run the
 * same claim fixtures (the conformance suite's default-deny cases, ADR-0027/0028):
 *
 *   CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}'
 *
 * Tenant = the key (identity 1:1, like the POST /claims write path). Real deployments
 * use KubeClaimSource (CRD) or DynamoClaimSource (table) behind the same port.
 */
import type { ClaimSource, InferenceClaim } from "../claims";

type StaticClaimSpec = { model?: string; monthlyBudgetUsd?: number; sessionBudgetUsd?: number };

export class StaticClaimSource implements ClaimSource {
  readonly name = "static";
  private readonly claims = new Map<string, InferenceClaim>();

  constructor(spec?: string) {
    const parsed: Record<string, StaticClaimSpec> = spec ? JSON.parse(spec) : {};
    for (const [identity, c] of Object.entries(parsed)) {
      this.claims.set(identity, {
        tenant: identity,
        serviceAccount: identity,
        model: c.model,
        monthlyBudgetUsd: c.monthlyBudgetUsd,
        sessionBudgetUsd: c.sessionBudgetUsd,
      });
    }
  }

  async forServiceAccount(serviceAccount: string): Promise<InferenceClaim | undefined> {
    return this.claims.get(serviceAccount);
  }

  async forTenant(tenant: string): Promise<InferenceClaim | undefined> {
    return this.claims.get(tenant);
  }
}
