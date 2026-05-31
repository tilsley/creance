/**
 * Proves the gateway's POST /claims handler (ADR-0021, tenant = identity 1:1): verifies the
 * caller's identity, sets tenant = that identity (no derivation), validates against the default
 * allowance, and writes a claim keyed by + scoped to the identity. Mock deps (mirrors generate.test.ts).
 */
import { test, expect } from "bun:test";
import { handleCreateClaim } from "./claims";
import type { ClaimWrite, InferenceClaim } from "@agent-os/core";

const allowance = { maxMonthlyUsd: 100, allowedModels: ["claude-haiku", "nova-lite"] };
const makeDeps = (overrides: Partial<ClaimWrite> = {}): { deps: ClaimWrite; written: InferenceClaim[] } => {
  const written: InferenceClaim[] = [];
  const deps: ClaimWrite = {
    verifyIdentity: async (t) => (t === "good" ? "system:serviceaccount:agent-os:bot" : undefined),
    allowance,
    putClaim: async (c) => { written.push(c); },
    ...overrides,
  };
  return { deps, written };
};
const post = (body: unknown, auth?: string) =>
  new Request("http://gw/claims", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });

test("201 on a valid self-service claim; tenant = the verified identity, keyed by it", async () => {
  const { deps, written } = makeDeps();
  const res = await handleCreateClaim(post({ model: "claude-haiku", monthlyBudgetUsd: 50 }, "Bearer good"), deps);
  expect(res.status).toBe(201);
  expect(written).toEqual([{ tenant: "system:serviceaccount:agent-os:bot", serviceAccount: "system:serviceaccount:agent-os:bot", model: "claude-haiku", monthlyBudgetUsd: 50, sessionBudgetUsd: undefined }]);
});

test("401 with no bearer and with an unverifiable token", async () => {
  const { deps, written } = makeDeps();
  expect((await handleCreateClaim(post({ model: "claude-haiku", monthlyBudgetUsd: 50 }), deps)).status).toBe(401);
  expect((await handleCreateClaim(post({ model: "claude-haiku", monthlyBudgetUsd: 50 }, "Bearer bad"), deps)).status).toBe(401);
  expect(written).toEqual([]);
});

test("400 on over-allowance budget and on a disallowed model — no write", async () => {
  const { deps, written } = makeDeps();
  expect((await handleCreateClaim(post({ model: "claude-haiku", monthlyBudgetUsd: 500 }, "Bearer good"), deps)).status).toBe(400);
  expect((await handleCreateClaim(post({ model: "gpt-9", monthlyBudgetUsd: 10 }, "Bearer good"), deps)).status).toBe(400);
  expect(written).toEqual([]);
});
