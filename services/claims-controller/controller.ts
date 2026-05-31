#!/usr/bin/env bun
/**
 * claims-controller (ADR-0021 / slice 7) — the cross-object + status half of inference
 * onboarding that a ValidatingAdmissionPolicy can't do. Periodically: sum each namespace's
 * InferenceClaims against its InferenceAllowance and write status.conditions[Ready]. The gateway
 * (KubeClaimSource) then honours only non-Rejected claims. Level-based resync, no watch — the
 * agent-controller pattern (ADR-0012). Provisions nothing in AWS.
 *
 *   RECONCILE_INTERVAL_MS via env.
 */
import * as k8s from "@kubernetes/client-node";
import { evaluate, type ClaimLite } from "./evaluate";

const GROUP = "agent-os.io";
const VERSION = "v1alpha1";
const CLAIMS = "inferenceclaims";
const ALLOWANCES = "inferenceallowances";
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 10000);

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const api = kc.makeApiClient(k8s.CustomObjectsApi);

const num = (v: unknown) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : undefined;
};

async function reconcileOnce(): Promise<void> {
  const claimsRes: any = await api.listCustomObjectForAllNamespaces({ group: GROUP, version: VERSION, plural: CLAIMS });
  const allowRes: any = await api.listCustomObjectForAllNamespaces({ group: GROUP, version: VERSION, plural: ALLOWANCES });

  // allowance cap per namespace (the "default" allowance)
  const capByNs = new Map<string, number | undefined>();
  for (const a of allowRes?.items ?? []) capByNs.set(a.metadata?.namespace, num(a.spec?.maxMonthlyUsd));

  // group claims by namespace
  const byNs = new Map<string, any[]>();
  for (const o of claimsRes?.items ?? []) {
    const ns = o.metadata?.namespace;
    if (!ns) continue;
    (byNs.get(ns) ?? byNs.set(ns, []).get(ns)!).push(o);
  }

  for (const [ns, claims] of byNs) {
    const lite: ClaimLite[] = claims.map((o) => ({
      name: o.metadata?.name,
      monthlyBudgetUsd: num(o.spec?.monthlyBudgetUsd) ?? 0,
      creationTimestamp: o.metadata?.creationTimestamp,
    }));
    const verdicts = evaluate(lite, capByNs.get(ns));
    for (const o of claims) {
      const name = o.metadata?.name;
      const v = verdicts.get(name);
      if (!v) continue;
      const desired = { type: "Ready", status: v.ready ? "True" : "False", reason: v.reason, message: v.message, observedGeneration: o.metadata?.generation };
      const cur = (o.status?.conditions ?? []).find((c: any) => c.type === "Ready");
      if (cur && cur.status === desired.status && cur.reason === desired.reason && cur.message === desired.message) continue; // converged
      o.status = { ...(o.status ?? {}), conditions: [{ ...desired, lastTransitionTime: new Date().toISOString() }] };
      try {
        await api.replaceNamespacedCustomObjectStatus({ group: GROUP, version: VERSION, namespace: ns, plural: CLAIMS, name, body: o });
        console.log(`reconciled inferenceclaim/${ns}/${name}: Ready=${desired.status} (${desired.message})`);
      } catch (e: any) {
        console.error(`reconcile ${ns}/${name} failed:`, e?.body?.message ?? e?.message ?? e);
      }
    }
  }
}

console.log(`claims-controller: reconciling ${GROUP}/${CLAIMS} vs ${ALLOWANCES}, resync every ${INTERVAL_MS}ms`);
await reconcileOnce();
setInterval(() => void reconcileOnce().catch((e) => console.error("reconcile loop error:", e?.message ?? e)), INTERVAL_MS);
