/**
 * Proves the A2A server surface (ADR-0018): runToTask mapping, the Agent Card shape,
 * and the JSON-RPC dispatch (message/send → Task, tasks/get → Task, auth → 401,
 * unknown method → -32601).
 */
import { test, expect } from "bun:test";
import { runToTask, buildAgentCard, handleA2A, type GateOutcome } from "./a2a";
import type { Run } from "@agent-os/core";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  status: "queued",
  task: "do it",
  messages: [],
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

const rpc = (method: string, params: unknown, auth = "Bearer tok") =>
  new Request("http://host/a2a", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });

test("runToTask maps status and exposes completed output as an artifact", () => {
  expect(runToTask(run({ status: "queued" })).status.state).toBe("submitted");
  expect(runToTask(run({ status: "running" })).status.state).toBe("working");
  expect(runToTask(run({ status: "failed" })).status.state).toBe("failed");
  const done = runToTask(run({ status: "completed", output: "the answer" }));
  expect(done.status.state).toBe("completed");
  expect(done.artifacts?.[0]?.parts[0]).toEqual({ kind: "text", text: "the answer" });
});

test("buildAgentCard advertises the endpoint + bearer security scheme", () => {
  const card = buildAgentCard({ name: "enrich-bot", description: "d", url: "http://host/a2a" });
  expect(card.name).toBe("enrich-bot");
  expect(card.url).toBe("http://host/a2a");
  expect(card.protocolVersion).toBeTruthy();
  expect(card.securitySchemes.bearer).toMatchObject({ type: "http", scheme: "bearer" });
});

test("message/send: gates, creates a run, returns a Task; passes text + agent through", async () => {
  let seen: any;
  const deps = {
    createRun: async (cred: any, _h: any, agent: any, task: any): Promise<GateOutcome> => {
      seen = { cred, agent, task };
      return { ok: true, run: run({ id: "r9" }) };
    },
    getRun: async () => undefined,
    defaultAgent: "fallback-bot",
  };
  const res = await handleA2A(
    rpc("message/send", { message: { role: "user", parts: [{ kind: "text", text: "hi there" }] }, metadata: { agent: "enrich-bot" } }),
    deps,
  );
  const body: any = await res.json();
  expect(body.result).toMatchObject({ id: "r9", kind: "task", status: { state: "submitted" } });
  expect(seen).toEqual({ cred: "tok", agent: "enrich-bot", task: "hi there" });
});

test("message/send falls back to defaultAgent and 401s on auth failure", async () => {
  const denied = { createRun: async (): Promise<GateOutcome> => ({ ok: false, status: 401, error: "unauthorized" }), getRun: async () => undefined };
  const res = await handleA2A(rpc("message/send", { message: { parts: [{ kind: "text", text: "x" }] } }), denied);
  expect(res.status).toBe(401);
});

test("message/send forbidden → JSON-RPC error", async () => {
  const deps = { createRun: async (): Promise<GateOutcome> => ({ ok: false, status: 403, error: "forbidden", reason: "needs admins" }), getRun: async () => undefined };
  const body: any = await (await handleA2A(rpc("message/send", { message: { parts: [{ kind: "text", text: "x" }] } }), deps)).json();
  expect(body.error.code).toBe(-32000);
  expect(body.error.data).toMatchObject({ status: 403, reason: "needs admins" });
});

test("tasks/get returns the Task; unknown id → error; unknown method → -32601", async () => {
  const deps = { createRun: async (): Promise<GateOutcome> => ({ ok: true, run: run() }), getRun: async (id: string) => (id === "r1" ? run({ status: "completed", output: "ok" }) : undefined) };
  const ok: any = await (await handleA2A(rpc("tasks/get", { id: "r1" }), deps)).json();
  expect(ok.result.status.state).toBe("completed");
  const miss: any = await (await handleA2A(rpc("tasks/get", { id: "nope" }), deps)).json();
  expect(miss.error.code).toBe(-32001);
  const bad: any = await (await handleA2A(rpc("frobnicate", {}), deps)).json();
  expect(bad.error.code).toBe(-32601);
});
