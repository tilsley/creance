/**
 * Proves LocalGate sources each tenant's cap from a BudgetSource (e.g. the
 * Crossplane claim's monthlyBudgetUsd, ADR-0013) and falls back to the flat
 * GATE_BUDGET_USD default when the source has no entry for a tenant.
 */
import { test, expect } from "bun:test";
import { LocalGate } from "./local-gate";
import { InMemorySpendStore, currentPeriod, type BudgetSource } from "../gate";

// a fake source standing in for the claim reader: teama=$10, teamb=$50, others unknown
const fakeClaims: BudgetSource = {
  name: "fake",
  async limitFor(tenant) {
    return { teama: 10, teamb: 50 }[tenant];
  },
};

test("reads each tenant's cap from the BudgetSource", async () => {
  const gate = new LocalGate("1.00", { source: fakeClaims });

  expect((await gate.checkBudget("teama")).limitUsd).toBe(10);
  expect((await gate.checkBudget("teamb")).limitUsd).toBe(50);
});

test("falls back to the flat default when the source has no entry", async () => {
  const gate = new LocalGate("1.00", { source: fakeClaims });

  // 'teamc' has no claim -> the GATE_BUDGET_USD default applies
  expect((await gate.checkBudget("teamc")).limitUsd).toBe(1);
});

test("the per-tenant cap drives the ok/remaining verdict", async () => {
  const gate = new LocalGate("1.00", { source: fakeClaims });

  await gate.recordSpend("teama", 9.5);
  const a = await gate.checkBudget("teama");
  expect(a.ok).toBe(true); // 9.5 < 10
  expect(a.remainingUsd).toBeCloseTo(0.5);

  await gate.recordSpend("teama", 1.0); // now 10.5 > 10
  expect((await gate.checkBudget("teama")).ok).toBe(false);
});

test("with no source, every tenant gets the flat default (unchanged behaviour)", async () => {
  const gate = new LocalGate("2.50");
  expect((await gate.checkBudget("anyone")).limitUsd).toBe(2.5);
});

test("spend resets when the billing month rolls over", async () => {
  let clock = new Date("2026-05-20T00:00:00Z");
  const gate = new LocalGate("10", { now: () => clock });

  await gate.recordSpend("teama", 7);
  expect((await gate.checkBudget("teama")).spentUsd).toBe(7); // May

  clock = new Date("2026-06-01T00:00:00Z"); // new month -> new period key
  expect((await gate.checkBudget("teama")).spentUsd).toBe(0); // June starts fresh
  expect(currentPeriod(clock)).toBe("2026-06");
});

test("spend is durable across gate instances sharing a SpendStore (survives a restart)", async () => {
  const store = new InMemorySpendStore(); // stands in for the persistent DynamoSpendStore
  const before = new LocalGate("10", { spendStore: store });
  await before.recordSpend("teama", 4);

  // a fresh gate (as if the process restarted) reads the same store
  const after = new LocalGate("10", { spendStore: store });
  expect((await after.checkBudget("teama")).spentUsd).toBe(4);
});

test("InMemorySpendStore keeps periods independent and adds atomically", async () => {
  const store = new InMemorySpendStore();
  expect(await store.add("teama", "2026-05", 1.5)).toBe(1.5);
  expect(await store.add("teama", "2026-05", 0.5)).toBe(2.0); // accumulates
  expect(await store.get("teama", "2026-06")).toBe(0); // other month untouched
  expect(await store.get("teamb", "2026-05")).toBe(0); // other tenant untouched
});

// --- ADR-0019: atomic reserve/settle + the per-session scope --------------------

test("reserve atomically admits up to the cap and refuses the breach (no spend held)", async () => {
  const gate = new LocalGate("10");
  expect((await gate.reserve("teama", 4)).ok).toBe(true); // 4
  expect((await gate.reserve("teama", 4)).ok).toBe(true); // 8
  expect((await gate.reserve("teama", 4)).ok).toBe(false); // 12 > 10 — refused
  expect((await gate.checkBudget("teama")).spentUsd).toBe(8); // the refused one held nothing
});

test("refuses a single request larger than the whole cap", async () => {
  const gate = new LocalGate("1");
  expect((await gate.reserve("teama", 5)).ok).toBe(false);
  expect((await gate.checkBudget("teama")).spentUsd).toBe(0);
});

test("concurrent reservations never exceed the cap (TOCTOU closed)", async () => {
  const gate = new LocalGate("10"); // fits exactly 3 of these $3 reservations
  const results = await Promise.all(Array.from({ length: 5 }, () => gate.reserve("teama", 3)));
  expect(results.filter((r) => r.ok).length).toBe(3); // only 3 admitted, not 5
  expect((await gate.checkBudget("teama")).spentUsd).toBeLessThanOrEqual(10); // never overspent
});

test("settle reconciles a worst-case reservation down to actual spend", async () => {
  const gate = new LocalGate("100");
  await gate.reserve("teama", 5); // reserve worst case
  await gate.settle("teama", 2 - 5); // actual was $2 → refund the $3 difference
  expect((await gate.checkBudget("teama")).spentUsd).toBe(2);
});

test("the per-session cap stops a runaway session while the tenant still has room", async () => {
  const gate = new LocalGate("100", { sessionLimitUsd: 5 }); // big tenant cap, small session cap
  expect((await gate.reserve("teama", 2, { sessionId: "run1" })).ok).toBe(true); // session 2/5
  expect((await gate.reserve("teama", 2, { sessionId: "run1" })).ok).toBe(true); // session 4/5
  expect((await gate.reserve("teama", 2, { sessionId: "run1" })).ok).toBe(false); // session 6 > 5 — refused
  // tenant was refunded the failed session reserve, and a DIFFERENT session proceeds
  expect((await gate.reserve("teama", 2, { sessionId: "run2" })).ok).toBe(true); // new session
  expect((await gate.checkBudget("teama")).spentUsd).toBe(6); // run1: 4 + run2: 2 (the refused one held nothing)
});
