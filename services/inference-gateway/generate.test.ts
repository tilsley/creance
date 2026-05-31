/**
 * Proves the gateway's /v1/generate handler (ADR-0019): authenticates the caller and
 * derives tenant from the principal, runs one generate turn, and maps failures —
 * 401 unauth, 402 budget, 400 bad body. Mock deps (mirrors a2a.test.ts).
 */
import { test, expect } from "bun:test";
import { handleGenerate, type GenerateDeps } from "./generate";
import { UnauthorizedError, BudgetExceededError, type InferenceProvider, type Principal } from "@agent-os/core";

const principal: Principal = { tenant: "teama", subject: "system:serviceaccount:agent-os:bot", token: "tok" };
const okAuth = { name: "fake", async authenticate() { return principal; } };

const fakeProvider = (gen: InferenceProvider["generate"]): InferenceProvider => ({ name: "fake", model: "m", generate: gen });

const post = (body: unknown, auth = "Bearer tok") =>
  new Request("http://gw/v1/generate", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });

const body = { messages: [{ role: "user", text: "hi" }], tools: [], maxTokens: 128 };

test("authenticates, derives tenant from the principal, returns the AssistantTurn", async () => {
  let sawTenant: string | undefined, sawToken: string | undefined;
  const deps: GenerateDeps = {
    authenticator: okAuth,
    inferenceForTenant: async (tenant, token) => {
      sawTenant = tenant; sawToken = token;
      return fakeProvider(async () => ({ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }));
    },
  };
  const res = await handleGenerate(post(body), deps);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ text: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
  expect(sawTenant).toBe("teama"); // tenant came from the authenticated principal, not the body
  expect(sawToken).toBe("tok");
});

test("routes to the model named on the caller's claim (ADR-0021)", async () => {
  let sawModel: string | undefined;
  const deps: GenerateDeps = {
    authenticator: okAuth,
    modelFor: async (sa) => (sa === principal.subject ? "claude-haiku" : undefined),
    inferenceForTenant: async (_tenant, _token, _scope, model) => {
      sawModel = model;
      return fakeProvider(async () => ({ text: "ok", toolCalls: [] }));
    },
  };
  const res = await handleGenerate(post(body), deps);
  expect(res.status).toBe(200);
  expect(sawModel).toBe("claude-haiku"); // the gateway resolved the claim's model and routed to it
});

test("401 when the caller fails authn", async () => {
  const deps: GenerateDeps = {
    authenticator: { name: "fake", async authenticate() { throw new UnauthorizedError(); } },
    inferenceForTenant: async () => fakeProvider(async () => ({ toolCalls: [] })),
  };
  const res = await handleGenerate(post(body), deps);
  expect(res.status).toBe(401);
});

test("402 when admission throws BudgetExceededError", async () => {
  const deps: GenerateDeps = {
    authenticator: okAuth,
    inferenceForTenant: async () => fakeProvider(async () => {
      throw new BudgetExceededError({ tenant: "teama", limitUsd: 1, spentUsd: 2, remainingUsd: -1, ok: false });
    }),
  };
  const res = await handleGenerate(post(body), deps);
  expect(res.status).toBe(402);
  expect((await res.json()).budget).toMatchObject({ tenant: "teama", ok: false });
});

test("400 on a bad body (missing messages/maxTokens)", async () => {
  const deps: GenerateDeps = { authenticator: okAuth, inferenceForTenant: async () => fakeProvider(async () => ({ toolCalls: [] })) };
  const res = await handleGenerate(post({ messages: "nope" }), deps);
  expect(res.status).toBe(400);
});
