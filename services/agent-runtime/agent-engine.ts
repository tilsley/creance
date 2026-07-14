/**
 * agent-runtime agent-engine — the L1 loop hosted on GCP Vertex **Agent Runtime**
 * (Gemini Enterprise Agent Platform), the fourth deployment profile and the GCP
 * sibling of the AWS AgentCore profile (ADR-0042). This is the "fourth entrypoint,
 * same image" (cf. lambda.ts / task.ts): the managed runtime invokes our container
 * over HTTP instead of launching a Fargate task, but the run body (process-run.ts)
 * and provider wiring are byte-identical.
 *
 * The custom-container contract (Vertex custom-container serving, applied to Agent
 * Runtime BYOC):
 *   - Listen on 0.0.0.0:${AIP_HTTP_PORT}  (default 8080).
 *   - Health check: respond 200 within 10s on ${AIP_HEALTH_ROUTE} (and we answer a
 *     few common health paths defensively).
 *   - Query: Agent Runtime POSTs an invocation (reasoningEngines :query /
 *     :streamQuery). The exact in-container path + body shape are under-documented,
 *     so THIS entrypoint LOGS every request (method/path/body) — the first live
 *     deploy reveals the true contract, then we tighten. Body is expected as
 *     { class_method?, input: {...} }; the method's return value is the response.
 *
 * PROBE MODE (default when input has no `task`): return a runtime envelope proving
 * Agent Runtime ↔ our container works, WITHOUT a model call — so phase-1 ("prove
 * the invoke path, the authorizer, the envelope") is green before inference on GCP
 * is wired. A real `task` triggers an actual run via the shared app handler.
 *
 *   AIP_HTTP_PORT=8080 DISPATCH=inprocess bun run services/agent-runtime/agent-engine.ts
 */
import { providersFromEnv } from "@agent-os/core";
import { createApp } from "./app";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const { runStore: store } = providers;
const port = Number(process.env.AIP_HTTP_PORT ?? process.env.PORT ?? 8080);
const healthRoute = process.env.AIP_HEALTH_ROUTE ?? "/healthz";
const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;

// The runtime hosts the loop, so runs execute in THIS process — force inprocess
// dispatch regardless of the ambient env (a stray DISPATCH=runtask here would try
// to launch Fargate from inside GCP). This mirrors task.ts owning its own run.
process.env.DISPATCH = "inprocess";
const app = createApp(providers, { maxOutputTokens, a2aAgent: process.env.A2A_AGENT });

/** Redacted, bounded log of an incoming invocation — the empirical contract probe. */
function logInvocation(method: string, path: string, body: unknown): void {
  const preview = JSON.stringify(body ?? null).slice(0, 800);
  console.log(`agent-engine invoke: ${method} ${path} body=${preview}`);
}

/** Poll the run store until the run reaches a terminal state (query is synchronous).
 *  Bounded so a stuck run can't hold the invocation open forever. */
async function awaitRun(runId: string, timeoutMs = 110_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await store.get(runId);
    if (run && (run.status === "succeeded" || run.status === "failed")) return run;
    if (Date.now() > deadline) return run; // return whatever we have; caller sees non-terminal
    await new Promise((r) => setTimeout(r, 500));
  }
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  idleTimeout: 120, // long agent turns; the managed runtime allows long sessions
  async fetch(req) {
    const url = new URL(req.url);

    // Health — the runtime's liveness/readiness probe. Answer the configured route
    // and the usual suspects; body is ignored by the platform.
    if (req.method === "GET" && (url.pathname === healthRoute || url.pathname === "/" || url.pathname === "/ping")) {
      return Response.json({ status: "ok", runtime: "agent-engine" });
    }

    // Everything else that's a POST is treated as a query invocation (path logged so
    // we learn the real route). GET on an unknown path → 404.
    if (req.method !== "POST") return new Response("not found", { status: 404 });

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      /* leave body null; still logged */
    }
    logInvocation(req.method, url.pathname, body);

    const classMethod: string = body?.class_method ?? "query";
    const input: any = body?.input ?? body ?? {};

    // PROBE MODE — prove the envelope without a model call.
    const task: unknown = input?.task;
    if (input?.probe === true || typeof task !== "string" || !task.trim()) {
      return Response.json({
        ok: true,
        mode: "probe",
        runtime: "agent-engine",
        class_method: classMethod,
        dispatch: process.env.DISPATCH,
        providers: {
          store: providers.runStore.name,
          gate: providers.gate.name,
          authn: providers.authenticator.name,
          authz: providers.authorizer.name,
          inference: providers.inference.name,
          sandbox: providers.sandbox.name,
          memory: providers.memory?.name ?? "off",
        },
        echo: input,
      });
    }

    // REAL RUN — if the front door pre-created the run (DISPATCH=agentengine passes a
    // runId), execute that; otherwise create one inline via the shared gate (POST /runs)
    // and run it to completion in-process. Reuses app.ts so the gate/authz path is identical.
    const authz = req.headers.get("authorization");
    if (typeof input?.runId === "string") {
      const { processRun } = await import("./process-run");
      await processRun(providers, input.runId, { maxOutputTokens });
      return Response.json(await store.get(input.runId));
    }

    const create = await app(
      new Request("https://agent-engine.local/runs", {
        method: "POST",
        headers: { "content-type": "application/json", ...(authz ? { authorization: authz } : {}) },
        body: JSON.stringify({ task, agent: input?.agent, repo: input?.repo }),
      }),
    );
    if (create.status !== 202) return create; // gate refusal (401/402/403/400) — surface as-is
    const { runId } = (await create.json()) as { runId: string };
    const run = await awaitRun(runId);
    return Response.json(run ?? { runId, status: "unknown" });
  },
});

console.log(
  `agent-engine listening on 0.0.0.0:${server.port}  (Vertex Agent Runtime; health=${healthRoute}; ` +
    `dispatch=${process.env.DISPATCH}; store=${store.name}; gate=${providers.gate.name}; ` +
    `authn=${providers.authenticator.name} inference=${providers.inference.name} ` +
    `sandbox=${providers.sandbox.name} record=${providers.telemetry.name})`,
);
