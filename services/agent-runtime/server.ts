/**
 * agent-runtime — the L1 runtime as an HTTP service (the "front door"), now ASYNC.
 *
 * A run is a first-class, persisted entity (the State primitive — see core/runs):
 *   POST /runs  {"task":"..."}  -> 202 { runId, status:"queued" }   (returns immediately)
 *   an in-process worker executes it, persisting conversation + status each turn
 *   GET  /runs/{id}             -> the Run { status, messages, output?, error? }
 *   GET  /healthz               -> { status: "ok" }
 *
 * Why async: real agent runs are long-lived (minutes) and event-driven — a
 * blocking request/response can't host them. Durability comes from the RunStore:
 * state is persisted per turn, so a run is inspectable mid-flight (and, with a
 * persistent store, recoverable). Swappable later: in-process worker → SQS +
 * worker deployment; InMemoryRunStore → DynamoDB; all behind the same ports.
 *
 *   bun run start            (PORT, INFERENCE_PROVIDER, SANDBOX_PROVIDER, ... via env)
 */
import { runOnSession, providersFromEnv, workspaceTools, InMemoryRunStore, type Run, type RunStore } from "@agent-os/core";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const store: RunStore = new InMemoryRunStore();
const port = Number(process.env.PORT ?? 3000);

/** The worker: execute a queued run, persisting state as it goes. */
async function processRun(id: string): Promise<void> {
  if (!(await store.get(id))) return;
  const run = await store.update(id, { status: "running" });
  const session = await providers.sandbox.startSession();
  try {
    const result = await runOnSession({
      inference: providers.inference,
      guard: providers.guard,
      telemetry: providers.telemetry,
      session,
      task: run.task,
      tools: workspaceTools,
      onProgress: (messages) => {
        store.update(id, { messages }).catch(() => {}); // durable per-turn state
      },
    });
    await store.update(id, { status: result.status, output: result.output });
  } catch (e: any) {
    await store.update(id, { status: "failed", error: e?.message ?? String(e) });
  } finally {
    await session.close().catch(() => {});
  }
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/runs") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const task = body?.task;
      if (typeof task !== "string" || !task.trim()) {
        return Response.json({ error: "missing 'task' (string)" }, { status: 400 });
      }
      const now = new Date().toISOString();
      const run: Run = { id: crypto.randomUUID(), status: "queued", task, messages: [], createdAt: now, updatedAt: now };
      await store.create(run);
      void processRun(run.id); // fire-and-forget worker (in-process for now)
      return Response.json({ runId: run.id, status: run.status }, { status: 202 });
    }

    const match = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const run = await store.get(match[1]!);
      return run ? Response.json(run) : Response.json({ error: "run not found" }, { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `agent-runtime listening on :${server.port}  (async; store=${store.name}; ` +
    `inference=${providers.inference.name} sandbox=${providers.sandbox.name} ` +
    `guard=${providers.guard.name} record=${providers.telemetry.name})`,
);
