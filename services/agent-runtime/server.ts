/**
 * agent-runtime — the L1 agent loop as an HTTP service (the "front door").
 *
 * Built entirely on @agent-os/core; adapters are chosen by env (providersFromEnv)
 * ONCE at boot and reused across requests. This is the prototype→platform pivot:
 * the same validated loop, now an invocable, deployable service.
 *
 *   GET  /healthz                 -> { status: "ok" }
 *   POST /runs   {"task":"..."}   -> RunResult { runId, status, output? }
 *
 *   bun run start            (PORT, INFERENCE_PROVIDER, SANDBOX_PROVIDER, ... via env)
 */
import { runAgent, providersFromEnv } from "@agent-os/core";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && pathname === "/runs") {
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
      try {
        const result = await runAgent({ ...providers, task });
        return Response.json(result);
      } catch (e: any) {
        return Response.json({ error: e?.name ?? "error", message: e?.message }, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `agent-runtime listening on :${server.port}  ` +
    `(inference=${providers.inference.name} sandbox=${providers.sandbox.name} ` +
    `guard=${providers.guard.name} record=${providers.telemetry.name})`,
);
