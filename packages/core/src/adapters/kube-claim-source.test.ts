/**
 * Proves KubeClaimSource (ADR-0021) serves both consumers from one read of the claim CRD:
 * the authn SA→tenant resolver and the gate's budget cap. Covers BOTH scopes —
 * Namespaced (tenant = namespace, SA = full in-namespace identity; slice 6) and the legacy
 * Cluster (tenant = spec.tenant). Uses an injected lister (no cluster).
 */
import { test, expect } from "bun:test";
import { KubeClaimSource } from "./kube-claim-source";

// Namespaced claims: tenant is the claim's namespace; serviceAccount is the in-namespace name.
const nsItems = [
  { metadata: { namespace: "team-a" }, spec: { serviceAccount: "ticket-bot", model: "claude-haiku", monthlyBudgetUsd: "10", sessionBudgetUsd: "0.5" } },
  { metadata: { namespace: "team-b" }, spec: { serviceAccount: "bot", monthlyBudgetUsd: "50" } },
];
const nsSrc = () => new KubeClaimSource({ scope: "Namespaced" }, 30_000, async () => nsItems);

test("namespaced: forServiceAccount keys on the FULL identity; tenant = namespace", async () => {
  const c = await nsSrc().forServiceAccount("system:serviceaccount:team-a:ticket-bot");
  expect(c).toEqual({ tenant: "team-a", serviceAccount: "system:serviceaccount:team-a:ticket-bot", model: "claude-haiku", monthlyBudgetUsd: 10, sessionBudgetUsd: 0.5 });
});

test("namespaced: forTenant resolves by namespace; BudgetSource + SaTenantResolver agree", async () => {
  const s = nsSrc();
  expect((await s.forTenant("team-b"))?.monthlyBudgetUsd).toBe(50);
  expect(await s.limitFor("team-a")).toBe(10);
  expect(await s.tenantFor("system:serviceaccount:team-a:ticket-bot")).toBe("team-a");
});

test("namespaced: a tenant can't be bound by another namespace's SA name (full id required)", async () => {
  // 'ticket-bot' alone, or in the wrong namespace, does not resolve — only the full team-a id does
  const s = nsSrc();
  expect(await s.forServiceAccount("ticket-bot")).toBeUndefined();
  expect(await s.forServiceAccount("system:serviceaccount:team-b:ticket-bot")).toBeUndefined();
});

test("cluster (legacy): tenant + SA come from spec", async () => {
  const items = [{ spec: { tenant: "teama", serviceAccount: "system:serviceaccount:agent-os:run", monthlyBudgetUsd: "7" } }];
  const s = new KubeClaimSource({ scope: "Cluster" }, 30_000, async () => items);
  expect(await s.tenantFor("system:serviceaccount:agent-os:run")).toBe("teama");
  expect(await s.limitFor("teama")).toBe(7);
});
