/**
 * Proves DynamoClaimSource (ADR-0021) — the non-k8s ClaimSource — resolves a grant from a
 * DynamoDB-shaped item and satisfies BudgetSource + SaTenantResolver from the same store.
 * Uses an injected reader (no DynamoDB Local).
 */
import { test, expect } from "bun:test";
import { DynamoClaimSource, type DynamoClaimReader } from "./dynamo-claim-source";

const items: Record<string, any> = {
  "arn:aws:iam::123:role/ticket-svc": { serviceAccount: "arn:aws:iam::123:role/ticket-svc", tenant: "teama", model: "claude-haiku", monthlyBudgetUsd: 50, sessionBudgetUsd: 2 },
};
const reader: DynamoClaimReader = {
  async byServiceAccount(sa) { return items[sa]; },
  async byTenant(tenant) { return Object.values(items).find((i) => i.tenant === tenant); },
};
const src = () => new DynamoClaimSource("agent-os-claims", { reader });

test("forServiceAccount resolves a grant by the verified identity", async () => {
  expect(await src().forServiceAccount("arn:aws:iam::123:role/ticket-svc")).toEqual({
    tenant: "teama", serviceAccount: "arn:aws:iam::123:role/ticket-svc", model: "claude-haiku", monthlyBudgetUsd: 50, sessionBudgetUsd: 2,
  });
});

test("satisfies BudgetSource.limitFor + SaTenantResolver.tenantFor from the same store", async () => {
  const s = src();
  expect(await s.limitFor("teama")).toBe(50);
  expect(await s.tenantFor("arn:aws:iam::123:role/ticket-svc")).toBe("teama");
});

test("unknown identity / tenant → undefined; numeric-string budgets coerce", async () => {
  const s = new DynamoClaimSource("t", {
    reader: { async byServiceAccount() { return { serviceAccount: "x", tenant: "t1", monthlyBudgetUsd: "9.5" }; }, async byTenant() { return undefined; } },
  });
  expect(await s.forServiceAccount("x")).toMatchObject({ tenant: "t1", monthlyBudgetUsd: 9.5 });
  expect(await s.forTenant("nope")).toBeUndefined();
});
