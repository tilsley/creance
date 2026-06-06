/**
 * Proves the OpenAI-compatible gateway client (LiteLLM, ADR-0024/0026) translates our
 * neutral types ↔ OpenAI chat-completions, forwards the bearer, parses the response back
 * into an AssistantTurn, and maps 401/402 to the SAME errors the in-process path throws.
 */
import { test, expect, afterEach } from "bun:test";
import { OpenAIGatewayInferenceProvider } from "./openai-gateway-inference";
import { UnauthorizedError, BudgetExceededError } from "../gate";
import type { Message, ToolDef } from "../ports";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const tools: ToolDef[] = [{ name: "lookup", description: "find", inputSchema: { type: "object" } }];

const okResponse = {
  choices: [{ message: { content: "hello", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
};

test("POSTs /v1/chat/completions with bearer, OpenAI-shaped body; parses content+tool_calls+usage", async () => {
  const calls = stubFetch(200, okResponse);
  const p = new OpenAIGatewayInferenceProvider("http://gw:4000/", "claude-haiku", { token: "tok-abc", tenant: "teama", sessionId: "run-9" });
  const turn = await p.generate([{ role: "user", text: "hi" }], tools, { maxTokens: 256 });

  expect(calls[0]!.url).toBe("http://gw:4000/v1/chat/completions"); // trailing slash trimmed
  expect(calls[0]!.init.headers.authorization).toBe("Bearer tok-abc");
  const body = JSON.parse(calls[0]!.init.body);
  expect(body.model).toBe("claude-haiku");
  expect(body.max_tokens).toBe(256);
  expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(body.tools).toEqual([{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object" } } }]);
  expect(body.metadata).toEqual({ session_id: "run-9" }); // per-session cap hint

  expect(turn).toEqual({
    text: "hello",
    toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
    usage: { inputTokens: 12, outputTokens: 4 },
  });
  expect(p.name).toBe("openai-gateway");
});

test("translates assistant tool_calls + tool results into OpenAI messages", async () => {
  const calls = stubFetch(200, { choices: [{ message: { content: "done" } }], usage: {} });
  const history: Message[] = [
    { role: "user", text: "go" },
    { role: "assistant", text: "calling", toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }] },
    { role: "tool", results: [{ toolCallId: "c1", output: "42" }, { toolCallId: "c2", output: "43" }] },
  ];
  await new OpenAIGatewayInferenceProvider("http://gw:4000", "m").generate(history, [], { maxTokens: 10 });
  const msgs = JSON.parse(calls[0]!.init.body).messages;
  expect(msgs[1]).toEqual({ role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] });
  // one OpenAI `tool` message per result
  expect(msgs[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "42" });
  expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c2", content: "43" });
});

test("maps HTTP 401 → UnauthorizedError", async () => {
  stubFetch(401, { error: { message: "unauthorized" } });
  const p = new OpenAIGatewayInferenceProvider("http://gw:4000", "m", { token: "bad" });
  await expect(p.generate([{ role: "user", text: "hi" }], [], { maxTokens: 10 })).rejects.toBeInstanceOf(UnauthorizedError);
});

test("maps HTTP 402 → BudgetExceededError (fallback status carries the tenant)", async () => {
  stubFetch(402, { error: { message: "budget exceeded for tenant 'teama'" } });
  const p = new OpenAIGatewayInferenceProvider("http://gw:4000", "m", { token: "t", tenant: "teama" });
  const err = await p.generate([{ role: "user", text: "hi" }], [], { maxTokens: 10 }).catch((e) => e);
  expect(err).toBeInstanceOf(BudgetExceededError);
  expect(err.status.tenant).toBe("teama");
});

test("omits Authorization when no token; omits tools/metadata when empty", async () => {
  const calls = stubFetch(200, { choices: [{ message: { content: "x" } }] });
  await new OpenAIGatewayInferenceProvider("http://gw:4000", "m").generate([{ role: "user", text: "hi" }], [], { maxTokens: 10 });
  expect(calls[0]!.init.headers.authorization).toBeUndefined();
  const body = JSON.parse(calls[0]!.init.body);
  expect(body.tools).toBeUndefined();
  expect(body.metadata).toBeUndefined();
});

test("throws on other non-OK statuses", async () => {
  stubFetch(500, { error: "boom" });
  const p = new OpenAIGatewayInferenceProvider("http://gw:4000", "m", { token: "t" });
  await expect(p.generate([{ role: "user", text: "hi" }], [], { maxTokens: 10 })).rejects.toThrow(/HTTP 500/);
});
