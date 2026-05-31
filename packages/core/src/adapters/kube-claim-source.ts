/**
 * KubeClaimSource (ADR-0021) — reads inference claims from a cluster-scoped CRD and serves
 * BOTH consumers from one TTL'd list: the authn SA→tenant resolver and the gate's budget
 * source. Replaces the separate KubeBudgetSource + KubeSaTenantResolver (which each hit the
 * same CRD independently). The CRD coords are configurable (TENANT_CLAIM_* → ClaimCrd) so it
 * can read a standalone InferenceClaim CRD or the legacy TenantInferenceProfile claim.
 *
 * No controller: validation is the API server's job (the CRD's CEL rules); this just reads.
 */
import * as k8s from "@kubernetes/client-node";
import type { ClaimSource, InferenceClaim, ClaimCrd } from "../claims";
import type { BudgetSource } from "../gate";
import type { SaTenantResolver } from "./oidc-sa-authenticator";

const DEFAULTS = { group: "platform.agent-os.io", version: "v1alpha1", plural: "tenantinferenceprofiles" };

export class KubeClaimSource implements ClaimSource, BudgetSource, SaTenantResolver {
  readonly name = "kube-claim";
  /** lists the claim CRs' raw objects; kube-backed by default, injectable for tests. */
  private readonly lister: () => Promise<any[]>;
  private readonly namespaced: boolean;
  private cache?: { at: number; bySa: Map<string, InferenceClaim>; byTenant: Map<string, InferenceClaim> };

  constructor(claim: ClaimCrd = {}, private readonly ttlMs = 30_000, lister?: () => Promise<any[]>) {
    this.namespaced = claim.scope === "Namespaced";
    if (lister) {
      this.lister = lister;
    } else {
      const group = claim.group ?? DEFAULTS.group;
      const version = claim.version ?? DEFAULTS.version;
      const plural = claim.plural ?? DEFAULTS.plural;
      const kc = new k8s.KubeConfig();
      kc.loadFromDefault(); // in-cluster SA token, or ~/.kube/config locally
      const api = kc.makeApiClient(k8s.CustomObjectsApi);
      this.lister = async () => {
        const res: any = this.namespaced
          ? await api.listCustomObjectForAllNamespaces({ group, version, plural })
          : await api.listClusterCustomObject({ group, version, plural });
        return res?.items ?? [];
      };
    }
  }

  private async refresh(): Promise<NonNullable<typeof this.cache>> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache;
    const items = await this.lister();
    const bySa = new Map<string, InferenceClaim>();
    const byTenant = new Map<string, InferenceClaim>();
    for (const o of items) {
      // honour only non-Rejected claims (slice 7): the claims-controller writes Ready=False on
      // claims that overflow the namespace allowance. Fresh claims (no status) are honoured —
      // the VAP already validated them per-object at apply.
      if (isRejected(o)) continue;
      // Namespaced: tenant = the claim's namespace, SA = the in-namespace SA → full identity
      // (so a tenant can only bind SAs in its own namespace). Cluster: tenant/SA from spec.
      const ns = o?.metadata?.namespace;
      const claim = toClaim(o?.spec, this.namespaced ? ns : undefined);
      if (!claim) continue;
      byTenant.set(claim.tenant, claim);
      if (claim.serviceAccount) bySa.set(claim.serviceAccount, claim);
    }
    this.cache = { at: Date.now(), bySa, byTenant };
    return this.cache;
  }

  async forServiceAccount(serviceAccount: string): Promise<InferenceClaim | undefined> {
    return (await this.refresh()).bySa.get(serviceAccount);
  }
  async forTenant(tenant: string): Promise<InferenceClaim | undefined> {
    return (await this.refresh()).byTenant.get(tenant);
  }

  // BudgetSource — the gate reads each tenant's monthly cap from the claim.
  async limitFor(tenant: string): Promise<number | undefined> {
    return (await this.forTenant(tenant))?.monthlyBudgetUsd;
  }
  // SaTenantResolver — authn resolves a verified SA → its tenant (never the token).
  async tenantFor(serviceAccount: string): Promise<string | undefined> {
    return (await this.forServiceAccount(serviceAccount))?.tenant;
  }
}

/** A claim the controller marked over-allowance (status.conditions Ready=False) — not honoured. */
function isRejected(o: any): boolean {
  return (o?.status?.conditions ?? []).some((c: any) => c?.type === "Ready" && c?.status === "False");
}

/** `namespace` set ⇒ namespaced claim: tenant = namespace, SA = the full in-namespace identity. */
function toClaim(spec: any, namespace?: string): InferenceClaim | undefined {
  if (!spec) return undefined;
  const tenant = namespace ?? (typeof spec.tenant === "string" ? spec.tenant : undefined);
  if (!tenant) return undefined;
  const num = (v: unknown) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) ? n : undefined;
  };
  const saName = typeof spec.serviceAccount === "string" ? spec.serviceAccount : undefined;
  const serviceAccount = saName == null ? undefined : namespace ? `system:serviceaccount:${namespace}:${saName}` : saName;
  return {
    tenant,
    serviceAccount,
    model: typeof spec.model === "string" ? spec.model : undefined,
    monthlyBudgetUsd: num(spec.monthlyBudgetUsd),
    sessionBudgetUsd: num(spec.sessionBudgetUsd),
  };
}
