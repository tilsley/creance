/**
 * Proves KubeClaimSource (ADR-0021) serves both consumers from one read of the claim CRD:
 * the authn SA→tenant resolver and the gate's budget cap — indexed by SA and by tenant.
 * Uses an injected lister (no cluster).
 */
import { test, expect } from "bun:test";
import { KubeClaimSource } from "./kube-claim-source";

const items = [
  { spec: { tenant: "teama", serviceAccount: "system:serviceaccount:agentos-e2e:caller", model: "claude-haiku", monthlyBudgetUsd: "10", sessionBudgetUsd: "0.5" } },
  { spec: { tenant: "teamb", serviceAccount: "system:serviceaccount:teamb:bot", monthlyBudgetUsd: "50" } },
  { spec: { /* no tenant */ serviceAccount: "system:serviceaccount:x:y" } }, // skipped
];
const src = () => new KubeClaimSource({}, 30_000, async () => items);

test("forServiceAccount resolves a verified SA → its full claim", async () => {
  const c = await src().forServiceAccount("system:serviceaccount:agentos-e2e:caller");
  expect(c).toEqual({ tenant: "teama", serviceAccount: "system:serviceaccount:agentos-e2e:caller", model: "claude-haiku", monthlyBudgetUsd: 10, sessionBudgetUsd: 0.5 });
});

test("forTenant resolves a tenant → its claim (numbers coerced)", async () => {
  expect((await src().forTenant("teamb"))?.monthlyBudgetUsd).toBe(50);
});

test("satisfies BudgetSource.limitFor and SaTenantResolver.tenantFor from the same read", async () => {
  const s = src();
  expect(await s.limitFor("teama")).toBe(10);
  expect(await s.tenantFor("system:serviceaccount:agentos-e2e:caller")).toBe("teama");
});

test("unknown SA / tenant → undefined; claims without a tenant are skipped", async () => {
  const s = src();
  expect(await s.forServiceAccount("system:serviceaccount:x:y")).toBeUndefined(); // had no tenant
  expect(await s.forTenant("nope")).toBeUndefined();
  expect(await s.limitFor("nope")).toBeUndefined();
});
