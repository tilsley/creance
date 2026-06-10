/**
 * StaticClaimSource — the CLAIMS_STATIC env map (mirror of the LiteLLM hook's), tenant =
 * identity 1:1. Powers the conformance suite's default-deny cases without k8s/AWS.
 */
import { test, expect } from "bun:test";
import { StaticClaimSource } from "./static-claim-source";

const src = new StaticClaimSource('{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5,"sessionBudgetUsd":1}}');

test("resolves a claimed identity (tenant = identity, 1:1)", async () => {
  expect(await src.forServiceAccount("bob")).toEqual({
    tenant: "bob",
    serviceAccount: "bob",
    model: "claude-haiku",
    monthlyBudgetUsd: 5,
    sessionBudgetUsd: 1,
  });
  expect((await src.forTenant("bob"))?.model).toBe("claude-haiku");
});

test("unknown identity → undefined (the gateway then default-denies, ADR-0028)", async () => {
  expect(await src.forServiceAccount("carol")).toBeUndefined();
});

test("no spec → empty source", async () => {
  expect(await new StaticClaimSource().forServiceAccount("bob")).toBeUndefined();
});
