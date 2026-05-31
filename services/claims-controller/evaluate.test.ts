import { test, expect } from "bun:test";
import { evaluate } from "./evaluate";

const c = (name: string, usd: number, ts: string) => ({ name, monthlyBudgetUsd: usd, creationTimestamp: ts });

test("claims that fit the allowance are Ready; the tipping claim + later are Rejected", () => {
  const v = evaluate([c("a", 60, "t1"), c("b", 50, "t2"), c("d", 10, "t3")], 100);
  expect(v.get("a")?.ready).toBe(true); // sum 60
  expect(v.get("b")?.ready).toBe(false); // sum 110 > 100
  expect(v.get("b")?.reason).toBe("AllowanceExceeded");
  expect(v.get("d")?.ready).toBe(false); // 120 > 100
});

test("ordered by creationTimestamp — earliest claims keep the budget", () => {
  const v = evaluate([c("late", 95, "t9"), c("early", 10, "t1")], 100);
  expect(v.get("early")?.ready).toBe(true); // 10
  expect(v.get("late")?.ready).toBe(false); // 105 > 100
});

test("everything fits under the cap → all Ready", () => {
  const v = evaluate([c("a", 10, "t1"), c("b", 20, "t2")], 100);
  expect([...v.values()].every((x) => x.ready)).toBe(true);
});

test("no allowance → all Rejected (defensive)", () => {
  const v = evaluate([c("a", 1, "t1")], undefined);
  expect(v.get("a")?.ready).toBe(false);
  expect(v.get("a")?.reason).toBe("NoAllowance");
});
