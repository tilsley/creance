/**
 * Proves the inference-gateway client (ADR-0019) forwards generate over HTTP with the
 * right shape + bearer, parses the AssistantTurn, and maps the gateway's 401/402 back to
 * the SAME errors the in-process path throws — so callers are transport-agnostic.
 */
import { test, expect, afterEach } from "bun:test";
import { GatewayInferenceProvider } from "./gateway-inference";
import { UnauthorizedError, BudgetExceededError } from "../gate";
import type { Message, ToolDef } from "../ports";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// capture the outbound request and reply with a canned Response
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const msgs: Message[] = [{ role: "user", text: "hi" }];
const tools: ToolDef[] = [{ name: "t", description: "d", inputSchema: { type: "object" } }];

test("POSTs to {url}/v1/generate with bearer + body, returns the AssistantTurn", async () => {
  const calls = stubFetch(200, { text: "ok", toolCalls: [{ id: "c1", name: "t", input: { a: 1 } }], usage: { inputTokens: 5, outputTokens: 3 } });
  const p = new GatewayInferenceProvider("http://gw:3100/", "amazon.nova-lite-v1:0", { token: "tok-abc", tenant: "teama" });
  const turn = await p.generate(msgs, tools, { maxTokens: 256 });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("http://gw:3100/v1/generate"); // trailing slash trimmed
  expect(calls[0]!.init.headers.authorization).toBe("Bearer tok-abc");
  expect(JSON.parse(calls[0]!.init.body)).toEqual({ messages: msgs, tools, maxTokens: 256 });
  expect(turn).toEqual({ text: "ok", toolCalls: [{ id: "c1", name: "t", input: { a: 1 } }], usage: { inputTokens: 5, outputTokens: 3 } });
  expect(p.name).toBe("gateway");
  expect(p.model).toBe("amazon.nova-lite-v1:0");
});

test("maps HTTP 401 → UnauthorizedError", async () => {
  stubFetch(401, { error: "unauthorized" });
  const p = new GatewayInferenceProvider("http://gw:3100", "m", { token: "bad" });
  await expect(p.generate(msgs, tools, { maxTokens: 10 })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("maps HTTP 402 → BudgetExceededError (carrying the gateway's budget status)", async () => {
  const budget = { tenant: "teama", limitUsd: 1, spentUsd: 2, remainingUsd: -1, ok: false };
  stubFetch(402, { error: "budget exceeded", budget });
  const p = new GatewayInferenceProvider("http://gw:3100", "m", { token: "t", tenant: "teama" });
  const err = await p.generate(msgs, tools, { maxTokens: 10 }).catch((e) => e);
  expect(err).toBeInstanceOf(BudgetExceededError);
  expect(err.status).toEqual(budget);
});

test("omits the Authorization header when no token is configured", async () => {
  const calls = stubFetch(200, { toolCalls: [] });
  const p = new GatewayInferenceProvider("http://gw:3100", "m");
  await p.generate(msgs, tools, { maxTokens: 10 });
  expect(calls[0]!.init.headers.authorization).toBeUndefined();
});

test("throws on other non-OK statuses", async () => {
  stubFetch(500, { error: "boom" });
  const p = new GatewayInferenceProvider("http://gw:3100", "m", { token: "t" });
  await expect(p.generate(msgs, tools, { maxTokens: 10 })).rejects.toThrow(/HTTP 500/);
});
