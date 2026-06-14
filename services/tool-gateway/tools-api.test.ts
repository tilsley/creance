/**
 * Tool-gateway handler tests (ADR-0011 dir. b / 0029) with mock deps — mirrors
 * services/inference-gateway/generate.test.ts. Asserts the gate contract: authn → tenant →
 * per-tenant toolset → list/execute, with default-deny for un-permitted/unknown tools.
 */
import { test, expect } from "bun:test";
import { handleToolsList, handleToolsCall, type ToolGatewayDeps } from "./tools-api";
import { UnauthorizedError } from "@agent-os/core";

// mock authenticator: tok-a → teamA, anything else → unauthorized
const authenticator = {
  name: "mock",
  async authenticate(ctx: { credential?: string }) {
    if (ctx.credential === "tok-a") return { tenant: "teamA", subject: "alice", token: ctx.credential };
    throw new UnauthorizedError();
  },
} as any;

// mock resolveTools: teamA gets one tool that echoes its input; everyone else gets nothing (policy)
const deps: ToolGatewayDeps = {
  authenticator,
  resolveTools: async (p) => ({
    tools:
      p.tenant === "teamA"
        ? [{ spec: { name: "orders__lookup_order", description: "d", inputSchema: {} }, run: async (i: any) => `ran ${JSON.stringify(i)}` }]
        : [],
    close: async () => {},
  }),
};

const post = (path: string, token?: string, body?: unknown) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

test("401 without a credential", async () => {
  expect((await handleToolsList(post("/tools/list"), deps)).status).toBe(401);
  expect((await handleToolsCall(post("/tools/call", undefined, { name: "x" }), deps)).status).toBe(401);
});

test("list returns the tenant's permitted tool specs (namespaced)", async () => {
  const j = (await (await handleToolsList(post("/tools/list", "tok-a"), deps)).json()) as { tools: { name: string }[] };
  expect(j.tools.map((t) => t.name)).toEqual(["orders__lookup_order"]);
});

test("call executes a permitted tool, server-side", async () => {
  const j = (await (await handleToolsCall(post("/tools/call", "tok-a", { name: "orders__lookup_order", input: { orderId: "ORD-42" } }), deps)).json()) as { output: string };
  expect(j.output).toContain("ORD-42");
});

test("call an un-permitted/unknown tool → 404 (default-deny, doesn't leak which)", async () => {
  expect((await handleToolsCall(post("/tools/call", "tok-a", { name: "secrets__exfil" }), deps)).status).toBe(404);
});

test("missing 'name' → 400", async () => {
  expect((await handleToolsCall(post("/tools/call", "tok-a", {}), deps)).status).toBe(400);
});
