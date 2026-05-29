/**
 * Proves LocalGate sources each tenant's cap from a BudgetSource (e.g. the
 * Crossplane claim's monthlyBudgetUsd, ADR-0013) and falls back to the flat
 * GATE_BUDGET_USD default when the source has no entry for a tenant.
 */
import { test, expect } from "bun:test";
import { LocalGate } from "./local-gate";
import type { BudgetSource } from "../gate";

// a fake source standing in for the claim reader: teama=$10, teamb=$50, others unknown
const fakeClaims: BudgetSource = {
  name: "fake",
  async limitFor(tenant) {
    return { teama: 10, teamb: 50 }[tenant];
  },
};

test("reads each tenant's cap from the BudgetSource", async () => {
  const gate = new LocalGate(undefined, "1.00", fakeClaims);

  expect((await gate.checkBudget("teama")).limitUsd).toBe(10);
  expect((await gate.checkBudget("teamb")).limitUsd).toBe(50);
});

test("falls back to the flat default when the source has no entry", async () => {
  const gate = new LocalGate(undefined, "1.00", fakeClaims);

  // 'teamc' has no claim -> the GATE_BUDGET_USD default applies
  expect((await gate.checkBudget("teamc")).limitUsd).toBe(1);
});

test("the per-tenant cap drives the ok/remaining verdict", async () => {
  const gate = new LocalGate(undefined, "1.00", fakeClaims);

  await gate.recordSpend("teama", 9.5);
  const a = await gate.checkBudget("teama");
  expect(a.ok).toBe(true); // 9.5 < 10
  expect(a.remainingUsd).toBeCloseTo(0.5);

  await gate.recordSpend("teama", 1.0); // now 10.5 > 10
  expect((await gate.checkBudget("teama")).ok).toBe(false);
});

test("with no source, every tenant gets the flat default (unchanged behaviour)", async () => {
  const gate = new LocalGate(undefined, "2.50");
  expect((await gate.checkBudget("anyone")).limitUsd).toBe(2.5);
});
