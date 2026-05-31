import { test, expect } from "bun:test";
import { validateClaim, type Allowance } from "./claims";

const allow: Allowance = { maxMonthlyUsd: 100, allowedModels: ["claude-haiku", "nova-lite"] };
const base = { tenant: "svc", serviceAccount: "svc", model: "claude-haiku", monthlyBudgetUsd: 50 };

test("accepts a claim within the allowance", () => {
  expect(validateClaim(base, allow)).toEqual({ ok: true });
});

test("rejects budget over the allowance max", () => {
  expect(validateClaim({ ...base, monthlyBudgetUsd: 500 }, allow)).toMatchObject({ ok: false });
});

test("rejects a model not in the allowance", () => {
  expect(validateClaim({ ...base, model: "gpt-9" }, allow).reason).toMatch(/not in the allowed models/);
});

test("rejects sessionBudget > monthlyBudget", () => {
  expect(validateClaim({ ...base, sessionBudgetUsd: 80, monthlyBudgetUsd: 50 }, allow).reason).toMatch(/sessionBudgetUsd must not exceed/);
});

test("rejects a missing/non-numeric budget and a missing model", () => {
  expect(validateClaim({ ...base, monthlyBudgetUsd: undefined }, allow).ok).toBe(false);
  expect(validateClaim({ ...base, model: undefined }, allow).reason).toMatch(/model is required/);
});
