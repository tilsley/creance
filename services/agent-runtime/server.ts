/**
 * agent-runtime — the L1 runtime as an HTTP service (the "front door"), async +
 * gated.
 *
 * A run is a first-class, persisted entity (the State primitive — core/runs),
 * scoped by the `gate` control (identity + budget — ADR-0009):
 *   POST /runs  {"task":"..."}  -> 202 { runId, status:"queued", tenant }
 *     Authorization: Bearer <token>  (under GATE=local; open under the default)
 *   GET  /runs/{id}                 -> the Run { status, messages, output?, usage, costUsd }
 *   GET  /tenants/{tenant}/budget   -> { limitUsd, spentUsd, remainingUsd, ok }
 *   GET  /healthz                   -> { status: "ok" }
 *
 * An in-process worker executes runs, persisting state each turn; spend is costed
 * from token usage and recorded against the tenant after each run.
 *
 *   GATE=local GATE_TOKENS="tok:teamA:alice" GATE_BUDGET_USD=1.00 bun run start
 */
import {
  runOnSession,
  providersFromEnv,
  workspaceTools,
  httpRequestTool,
  estimateCostUsd,
  UnauthorizedError,
  InMemoryRunStore,
  type Run,
  type RunStore,
} from "@agent-os/core";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const { gate, credentials } = providers;
const store: RunStore = new InMemoryRunStore();
const port = Number(process.env.PORT ?? 3000);

const bearer = (req: Request): string | undefined =>
  req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

/** The worker: execute a queued run, persisting state + accounting spend. */
async function processRun(id: string): Promise<void> {
  const existing = await store.get(id);
  if (!existing) return;
  const principal = existing.principal ?? { tenant: "default", subject: "anonymous" };
  const tenant = principal.tenant;
  await store.update(id, { status: "running" });
  const session = await providers.sandbox.startSession();
  try {
    const result = await runOnSession({
      inference: providers.inference,
      guard: providers.guard,
      telemetry: providers.telemetry,
      session,
      task: existing.task,
      // workspace + an authenticated outbound tool scoped to this run's principal
      // (creds applied server-side by the broker; ADR-0010)
      tools: (s) => [...workspaceTools(s), httpRequestTool(credentials, principal)],
      onProgress: (messages) => {
        store.update(id, { messages }).catch(() => {}); // durable per-turn state
      },
    });
    const costUsd = estimateCostUsd(providers.inference.model, result.usage);
    await gate.recordSpend(tenant, costUsd); // budget accounting (ADR-0009)
    await store.update(id, { status: result.status, output: result.output, usage: result.usage, costUsd });
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
      // gate: authenticate the caller, then pre-check the tenant's budget
      let principal;
      try {
        principal = await gate.authenticate(bearer(req));
      } catch (e) {
        if (e instanceof UnauthorizedError) return Response.json({ error: "unauthorized" }, { status: 401 });
        throw e;
      }
      const budget = await gate.checkBudget(principal.tenant);
      if (!budget.ok) return Response.json({ error: "budget exceeded", budget }, { status: 402 });

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
      const run: Run = { id: crypto.randomUUID(), status: "queued", task, principal, messages: [], createdAt: now, updatedAt: now };
      await store.create(run);
      void processRun(run.id); // fire-and-forget worker (in-process for now)
      return Response.json({ runId: run.id, status: run.status, tenant: principal.tenant }, { status: 202 });
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = await store.get(runMatch[1]!);
      return run ? Response.json(run) : Response.json({ error: "run not found" }, { status: 404 });
    }

    const budgetMatch = url.pathname.match(/^\/tenants\/([^/]+)\/budget$/);
    if (req.method === "GET" && budgetMatch) {
      return Response.json(await gate.checkBudget(budgetMatch[1]!));
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `agent-runtime listening on :${server.port}  (async; store=${store.name}; gate=${gate.name}; ` +
    `inference=${providers.inference.name} sandbox=${providers.sandbox.name} ` +
    `guard=${providers.guard.name} record=${providers.telemetry.name})`,
);
