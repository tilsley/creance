/**
 * A2A (Agent2Agent) protocol surface for the runtime (ADR-0018). Speaks the open
 * standard so other agents can discover + call ours, and ours can call theirs:
 *
 *   GET  /.well-known/agent-card.json   discovery (plain HTTP+JSON, not JSON-RPC)
 *   POST /a2a                            JSON-RPC 2.0: message/send, tasks/get
 *
 * A2A is the standard (methods, data model, lifecycle, discovery, auth); JSON-RPC
 * 2.0 is the wire format it's carried over. We map our Run onto A2A's Task, and rely
 * on the existing gate (authn via the Authorization bearer → authz → budget). Auth is
 * standard HTTP per the card's bearer security scheme. Core subset only — no
 * streaming (message/stream/SSE), push notifications, or cancel.
 */
import type { Run, RunStatus } from "@agent-os/core";

// --- A2A wire types (subset) ---
type TaskState = "submitted" | "working" | "completed" | "failed" | "canceled";
interface A2APart {
  kind: "text";
  text: string;
}
interface A2AArtifact {
  artifactId: string;
  name?: string;
  parts: A2APart[];
}
interface A2ATask {
  id: string;
  contextId: string;
  status: { state: TaskState };
  artifacts?: A2AArtifact[];
  kind: "task";
}

const STATE: Record<RunStatus, TaskState> = {
  queued: "submitted",
  running: "working",
  completed: "completed",
  failed: "failed",
  blocked: "failed",
  stuck: "failed",
};

/** Map our Run onto an A2A Task; completed runs expose their output as an artifact. */
export function runToTask(run: Run): A2ATask {
  const task: A2ATask = { id: run.id, contextId: run.id, status: { state: STATE[run.status] }, kind: "task" };
  if (run.status === "completed" && run.output != null) {
    task.artifacts = [{ artifactId: `${run.id}-result`, name: "result", parts: [{ kind: "text", text: run.output }] }];
  }
  return task;
}

export interface AgentCardOpts {
  name: string;
  description: string;
  url: string; // the A2A JSON-RPC endpoint
}

/** The discovery document served at /.well-known/agent-card.json. */
export function buildAgentCard(o: AgentCardOpts) {
  return {
    protocolVersion: "0.3.0",
    name: o.name,
    description: o.description,
    url: o.url,
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: o.name, name: o.name, description: o.description, tags: ["agent-os"] }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    security: [{ bearer: [] }],
  };
}

// --- JSON-RPC dispatch ---
/** Outcome of the shared gate+create sequence (implemented in server.ts). */
export type GateOutcome = { ok: true; run: Run } | { ok: false; status: number; error: string; reason?: string };

export interface A2ADeps {
  /** authn (Authorization bearer) → authz → budget → create a Run. */
  createRun: (credential: string | undefined, headers: Record<string, string>, agent: string | undefined, task: string) => Promise<GateOutcome>;
  getRun: (id: string) => Promise<Run | undefined>;
  /** Agent to run when message/send doesn't name one (this runtime's A2A_AGENT). */
  defaultAgent?: string;
}

const rpcError = (id: unknown, code: number, message: string, data?: unknown) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const rpcOk = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id: id ?? null, result });

/** Handle a POST /a2a JSON-RPC request: message/send + tasks/get. */
export async function handleA2A(req: Request, deps: A2ADeps): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const { id, method, params } = body ?? {};
  const credential = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const headers = Object.fromEntries(req.headers);

  if (method === "message/send") {
    const parts = (params?.message?.parts ?? []) as Array<{ kind?: string; text?: string }>;
    const task = parts.filter((p) => p?.kind === "text").map((p) => p.text ?? "").join("\n").trim();
    if (!task) return rpcError(id, -32602, "message has no text parts");
    const agent = params?.metadata?.agent ?? deps.defaultAgent;
    const outcome = await deps.createRun(credential, headers, agent, task);
    if (!outcome.ok) {
      // A2A: authn failures are HTTP 401 (with the bearer scheme); others → JSON-RPC error
      if (outcome.status === 401) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "www-authenticate": "Bearer" } });
      return rpcError(id, -32000, outcome.error, { status: outcome.status, reason: outcome.reason });
    }
    return rpcOk(id, runToTask(outcome.run));
  }

  if (method === "tasks/get") {
    const run = await deps.getRun(String(params?.id ?? ""));
    if (!run) return rpcError(id, -32001, "task not found");
    return rpcOk(id, runToTask(run));
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
