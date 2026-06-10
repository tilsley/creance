/**
 * Proves the /v1/messages Anthropic-wire handler (ADR-0028): verified identity →
 * claim (default-deny) → worst-case reserve → Bedrock passthrough → settle to actual —
 * including the streamed-spend rules ported from c07766a (pop-once settle, abandoned
 * streams stay spent) and the compat scrub. Mock deps (mirrors generate.test.ts).
 */
import { test, expect } from "bun:test";
import { handleMessages, toBedrockBody, estimateAnthropicInputTokens, type MessagesDeps } from "./messages";
import type { AnthropicEvent, AnthropicUpstream } from "./bedrock-anthropic";
import { UnauthorizedError, priceTokensUsd, type Gate, type BudgetStatus, type Principal } from "@agent-os/core";

const principal: Principal = { tenant: "teama", subject: "system:serviceaccount:agent-os:bot", token: "tok" };
const okAuth = { name: "fake", async authenticate() { return principal; } };

/** A gate that admits (or refuses) and records every reserve/settle. */
const fakeGate = (admit = true) => {
  const calls = { reserved: [] as number[], settled: [] as number[], scopes: [] as (string | undefined)[] };
  const status = (ok: boolean): BudgetStatus => ({ tenant: "teama", limitUsd: 5, spentUsd: 0, remainingUsd: 5, ok });
  const gate: Gate = {
    name: "fake",
    async checkBudget() { return status(true); },
    async recordSpend() { return status(true); },
    async reserve(_t, usd, scopes) { calls.reserved.push(usd); calls.scopes.push(scopes?.sessionId); return status(admit); },
    async settle(_t, delta) { calls.settled.push(delta); },
  };
  return { gate, calls };
};

const fakeUpstream = (over: Partial<AnthropicUpstream> = {}): AnthropicUpstream => ({
  invoke: async () => ({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 4 } }),
  invokeStream: async () => (async function* () {})(),
  ...over,
});

const post = (body: unknown, auth = "Bearer tok") =>
  new Request("http://gw/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });

const body = { model: "claude-haiku", messages: [{ role: "user", content: "hi" }], max_tokens: 100 };
const deps = (over: Partial<MessagesDeps> = {}): MessagesDeps => ({
  authenticator: okAuth,
  gate: fakeGate().gate,
  upstream: fakeUpstream(),
  resolveModel: (m) => m,
  ...over,
});

/** Drain an SSE response body to a string. */
const drain = async (res: Response) => {
  let text = "";
  for await (const chunk of res.body as ReadableStream<Uint8Array>) text += new TextDecoder().decode(chunk);
  return text;
};

// --- gate contract (the conformance cases, on the new wire) -------------------

test("401 when the caller fails authn", async () => {
  const res = await handleMessages(post(body), deps({
    authenticator: { name: "fake", async authenticate() { throw new UnauthorizedError(); } },
  }));
  expect(res.status).toBe(401);
});

test("400 when max_tokens is missing (it bounds the worst-case reserve)", async () => {
  const res = await handleMessages(post({ ...body, max_tokens: undefined }), deps());
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("max_tokens is required");
});

test("403 when a claim source is configured and the caller has no claim (default-deny, ADR-0028)", async () => {
  const res = await handleMessages(post(body), deps({ claimFor: async () => undefined }));
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain(principal.subject);
});

test("402 when the worst-case reserve is refused — nothing reaches the model", async () => {
  const { gate } = fakeGate(false);
  let invoked = false;
  const res = await handleMessages(post(body), deps({
    gate,
    upstream: fakeUpstream({ invoke: async () => { invoked = true; return {}; } }),
  }));
  expect(res.status).toBe(402);
  expect((await res.json()).budget).toMatchObject({ tenant: "teama", ok: false });
  expect(invoked).toBe(false);
});

test("routes to the claim's model, not the body's (the claim wins)", async () => {
  let sawModel: string | undefined;
  const res = await handleMessages(post(body), deps({
    claimFor: async () => ({ tenant: "teama", serviceAccount: principal.subject, model: "claude-sonnet" }),
    upstream: fakeUpstream({ invoke: async (modelId) => { sawModel = modelId; return { usage: {} }; } }),
  }));
  expect(res.status).toBe(200);
  expect(sawModel).toBe("claude-sonnet");
});

// --- non-streaming: passthrough + settle-to-actual ----------------------------

test("non-streaming: scrubbed passthrough body, Anthropic response verbatim, settles to actual", async () => {
  const { gate, calls } = fakeGate();
  let sawBody: Record<string, unknown> | undefined;
  const res = await handleMessages(
    post({ ...body, metadata: { user_id: "sess-1" }, tools: [{ name: "t", input_schema: {}, eager_input_streaming: true }] }),
    deps({ gate, upstream: fakeUpstream({ invoke: async (_m, _t, b) => { sawBody = b; return { content: [], usage: { input_tokens: 10, output_tokens: 4 } }; } }) }),
  );
  expect(res.status).toBe(200);
  expect((await res.json()).usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  // the wire scrub: model/stream/metadata gone, version added, SDK-skew field stripped
  expect(sawBody!.model).toBeUndefined();
  expect(sawBody!.metadata).toBeUndefined();
  expect(sawBody!.anthropic_version).toBe("bedrock-2023-05-31");
  expect((sawBody!.tools as any[])[0].eager_input_streaming).toBeUndefined();
  expect((sawBody!.tools as any[])[0].name).toBe("t");
  // budget: reserved the worst case, settled down to exactly actual − worst
  expect(calls.scopes[0]).toBe("sess-1"); // metadata.user_id became the session scope
  const actual = priceTokensUsd("claude-haiku", 10, 4);
  expect(calls.settled).toEqual([actual - calls.reserved[0]!]);
});

test("non-streaming: upstream failure refunds the full reservation", async () => {
  const { gate, calls } = fakeGate();
  const res = await handleMessages(post(body), deps({
    gate,
    upstream: fakeUpstream({ invoke: async () => { throw Object.assign(new Error("Extra inputs are not permitted"), { name: "ValidationException" }); } }),
  }));
  expect(res.status).toBe(400); // Bedrock validation → the client's fault
  expect(calls.settled).toEqual([-calls.reserved[0]!]);
});

// --- streaming: SSE re-framing + the c07766a spend rules -----------------------

const streamEvents: AnthropicEvent[] = [
  { type: "message_start", message: { usage: { input_tokens: 12 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
];

test("streaming: re-emits Anthropic-dialect SSE and settles ONCE to actual from message_delta usage", async () => {
  const { gate, calls } = fakeGate();
  const res = await handleMessages(post({ ...body, stream: true }), deps({
    gate,
    upstream: fakeUpstream({ invokeStream: async () => (async function* () { yield* streamEvents; })() }),
  }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const sse = await drain(res);
  // the dialect: named events, in order, data = the event verbatim
  expect(sse).toContain("event: message_start\ndata: ");
  expect(sse).toContain('"text_delta"');
  expect(sse.trim().split("\n\n").length).toBe(streamEvents.length);
  // pop-once settle, to exactly actual − worst (input from message_start, output from message_delta)
  const actual = priceTokensUsd("claude-haiku", 12, 7);
  expect(calls.settled).toEqual([actual - calls.reserved[0]!]);
});

test("streaming: pre-stream upstream failure is a JSON error (not broken SSE) + full refund", async () => {
  const { gate, calls } = fakeGate();
  const res = await handleMessages(post({ ...body, stream: true }), deps({
    gate,
    upstream: fakeUpstream({ invokeStream: async () => { throw new Error("boom"); } }),
  }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("inference failed");
  expect(calls.settled).toEqual([-calls.reserved[0]!]);
});

test("streaming: an abandoned stream stays spent at worst-case and aborts the upstream", async () => {
  const { gate, calls } = fakeGate();
  let aborted = false;
  const res = await handleMessages(post({ ...body, stream: true }), deps({
    gate,
    upstream: fakeUpstream({
      invokeStream: async (_m, _t, _b, signal) => (async function* () {
        signal?.addEventListener("abort", () => { aborted = true; });
        yield streamEvents[0]!;
        await new Promise(() => {}); // hang: the model keeps "thinking", the client walks away
      })(),
    }),
  }));
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // first event arrives...
  await reader.cancel(); // ...then the client disconnects
  await Bun.sleep(0);
  expect(aborted).toBe(true); // upstream call killed
  expect(calls.settled).toEqual([]); // no settle: reservation stays spent (over-charge, never a hole)
});

// --- pure helpers --------------------------------------------------------------

test("toBedrockBody preserves unknown-but-valid Anthropic fields (passthrough, not allowlist)", () => {
  const out = toBedrockBody({ model: "m", stream: true, system: "s", thinking: { type: "enabled", budget_tokens: 1 }, max_tokens: 5 });
  expect(out).toEqual({ system: "s", thinking: { type: "enabled", budget_tokens: 1 }, max_tokens: 5, anthropic_version: "bedrock-2023-05-31" });
});

test("toBedrockBody scrubs Anthropic-API-only skew fields Bedrock rejects (Claude Code ≥2.1)", () => {
  const out = toBedrockBody({ messages: [], max_tokens: 5, output_config: { effort: "high" }, context_management: { edits: [] } });
  expect(out.output_config).toBeUndefined();
  expect(out.context_management).toBeUndefined();
  expect(out.max_tokens).toBe(5);
});

test("estimateAnthropicInputTokens covers system + messages + tools at ~4 chars/token", () => {
  const n = estimateAnthropicInputTokens({ system: "abcd", messages: [{ role: "user", content: "abcd" }], tools: [] });
  expect(n).toBeGreaterThan(2);
  expect(estimateAnthropicInputTokens({})).toBe(0);
});
