#!/usr/bin/env bun
/**
 * agent-controller (#5, ADR-0012) — the reconciler half of the agent control plane.
 *
 * A minimal Kubernetes operator: periodically list Agent CRs, validate each, and
 * write `.status.phase` (Ready | Invalid) + a message. Runs as its OWN pod, separate
 * from agent-runtime (the in-process -> distributed split). Level-based reconcile
 * loop (resync); a production operator would also watch() for low-latency reaction.
 *
 *   AGENTS_NAMESPACE, RECONCILE_INTERVAL_MS via env.
 */
import * as k8s from "@kubernetes/client-node";

const GROUP = "agent-os.io";
const VERSION = "v1alpha1";
const PLURAL = "agents";
const NAMESPACE = process.env.AGENTS_NAMESPACE ?? "agent-os";
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 10000);

const kc = new k8s.KubeConfig();
kc.loadFromDefault(); // in-cluster SA token, or local kubeconfig
const api = kc.makeApiClient(k8s.CustomObjectsApi);

/** The reconcile decision: is this Agent definition valid? */
function validate(spec: any): { phase: "Ready" | "Invalid"; message: string } {
  if (!spec) return { phase: "Invalid", message: "spec is required" };
  if (spec.kind === "sandboxed") {
    // a sandboxed agent runs a delegated command in the sandbox (ADR-0019) — no systemPrompt
    if (typeof spec.command !== "string" || !spec.command.trim())
      return { phase: "Invalid", message: "spec.command is required for kind=sandboxed" };
  } else if (typeof spec.systemPrompt !== "string" || !spec.systemPrompt.trim()) {
    return { phase: "Invalid", message: "spec.systemPrompt is required" };
  }
  if (spec.maxSteps != null && (typeof spec.maxSteps !== "number" || spec.maxSteps < 1 || spec.maxSteps > 100))
    return { phase: "Invalid", message: "spec.maxSteps must be between 1 and 100" };
  return { phase: "Ready", message: "validated" };
}

async function reconcileOnce(): Promise<void> {
  const res: any = await api.listNamespacedCustomObject({ group: GROUP, version: VERSION, namespace: NAMESPACE, plural: PLURAL });
  for (const obj of res?.items ?? []) {
    const name = obj.metadata?.name;
    try {
      const desired = validate(obj.spec);
      const cur = obj.status ?? {};
      if (cur.phase === desired.phase && cur.message === desired.message) continue; // already converged
      obj.status = { ...cur, ...desired, observedGeneration: obj.metadata?.generation };
      await api.replaceNamespacedCustomObjectStatus({
        group: GROUP,
        version: VERSION,
        namespace: NAMESPACE,
        plural: PLURAL,
        name,
        body: obj,
      });
      console.log(`reconciled agent/${name}: ${cur.phase ?? "(none)"} -> ${desired.phase} (${desired.message})`);
    } catch (e: any) {
      console.error(`reconcile agent/${name} failed:`, e?.body?.message ?? e?.message ?? e);
    }
  }
}

console.log(`agent-controller: reconciling ${GROUP}/${PLURAL} in ns=${NAMESPACE}, resync every ${INTERVAL_MS}ms`);
await reconcileOnce();
setInterval(() => void reconcileOnce().catch((e) => console.error("reconcile loop error:", e?.message ?? e)), INTERVAL_MS);
