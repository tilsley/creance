/**
 * KubeBudgetSource — reads a tenant's spend cap from its Crossplane
 * `TenantInferenceProfile` claim (`platform.agent-os.io/v1alpha1`, cluster-scoped),
 * the same object the Composition expands into the AWS Budget. The cap is therefore
 * declared ONCE — `spec.monthlyBudgetUsd` on the claim — and both the AWS-side
 * Budget and the runtime's pre-flight admission gate read from it, instead of the
 * gate carrying a second hand-maintained copy in an env var (ADR-0013 / ADR-0009).
 *
 * Reads via the kube API (in-cluster ServiceAccount or local kubeconfig), exactly
 * like KubeAgentRegistry. Returns `undefined` when no claim matches the tenant, so
 * the gate falls back to its default. A short TTL cache keeps this off the per-turn
 * hot path (checkBudget runs on every inference call).
 *
 * NB: this sources the *limit*, not the spend *window*. `monthlyBudgetUsd` is a
 * monthly figure, but LocalGate's counter is process-lifetime in-memory — a true
 * monthly reset / restart-durable counter is the durable-gate concern (ADR-0009).
 */
import * as k8s from "@kubernetes/client-node";
import type { BudgetSource } from "../gate";

const GROUP = "platform.agent-os.io";
const VERSION = "v1alpha1";
const PLURAL = "tenantinferenceprofiles";

export class KubeBudgetSource implements BudgetSource {
  readonly name = "kube";
  private readonly api: k8s.CustomObjectsApi;
  private readonly cache = new Map<string, { usd: number | undefined; at: number }>();

  constructor(private readonly ttlMs = 30_000) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault(); // in-cluster SA token, or ~/.kube/config locally
    this.api = kc.makeApiClient(k8s.CustomObjectsApi);
  }

  async limitFor(tenant: string): Promise<number | undefined> {
    const hit = this.cache.get(tenant);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.usd;
    const usd = await this.fetch(tenant);
    this.cache.set(tenant, { usd, at: Date.now() });
    return usd;
  }

  /** Find the claim whose `spec.tenant` matches and read its `monthlyBudgetUsd`. */
  private async fetch(tenant: string): Promise<number | undefined> {
    const res: any = await this.api.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL });
    const claim = (res?.items ?? []).find((o: any) => o?.spec?.tenant === tenant);
    const raw = claim?.spec?.monthlyBudgetUsd;
    if (raw == null) return undefined;
    const usd = Number(raw);
    return Number.isFinite(usd) ? usd : undefined;
  }
}
