/**
 * Proves sigv4Fetch signs the request (ADR-0042 §3): the outgoing headers carry
 * a SigV4 Authorization for the bedrock-agentcore service and the body/method
 * pass through untouched. Static test credentials — no AWS, no network (the
 * final fetch is stubbed via Bun's global).
 */
import { test, expect, afterEach } from "bun:test";
import { sigv4Fetch } from "./sigv4-fetch";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

test("signs POSTs with a SigV4 authorization for bedrock-agentcore", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), init };
    return new Response("{}");
  }) as typeof fetch;

  const f = sigv4Fetch("eu-west-2", "bedrock-agentcore", creds);
  await f("https://gw.gateway.bedrock-agentcore.eu-west-2.amazonaws.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
  });

  const headers = captured!.init.headers as Record<string, string>;
  expect(headers["authorization"]).toStartWith("AWS4-HMAC-SHA256");
  expect(headers["authorization"]).toContain("eu-west-2/bedrock-agentcore/aws4_request");
  expect(headers["x-amz-date"]).toBeDefined();
  expect(headers["content-type"]).toBe("application/json");
  expect(new TextDecoder().decode(captured!.init.body as Uint8Array)).toContain("tools/list");
});

test("GETs (the SSE leg) sign without a body", async () => {
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured = init;
    return new Response("");
  }) as typeof fetch;

  const f = sigv4Fetch("eu-west-2", "bedrock-agentcore", creds);
  await f("https://gw.gateway.bedrock-agentcore.eu-west-2.amazonaws.com/mcp", { method: "GET" });

  expect((captured!.headers as Record<string, string>)["authorization"]).toStartWith("AWS4-HMAC-SHA256");
  expect(captured!.body).toBeUndefined();
});
