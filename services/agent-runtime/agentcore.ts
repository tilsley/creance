/**
 * agent-runtime on AgentCore Runtime — the L1 loop as a session-per-run microVM
 * (ADR-0042, the managed profile). Fourth entrypoint off the same image.
 *
 * AgentCore Runtime's service contract replaces the ECS RunTask lifecycle: the
 * router calls InvokeAgentRuntime with {runId} and Runtime delivers it here as
 * POST /invocations (port 8080). Same fire-and-forget shape as the Fargate task —
 * we ack immediately and process the run in the background; watchers poll the run
 * store exactly as in the other profiles (ADR-0031's stance, unchanged).
 *
 * GET /ping is Runtime's liveness/busy probe: "HealthyBusy" while a run is in
 * flight keeps the session alive past the sync window (the async-job contract,
 * ≤8h), and "Healthy" when idle lets the idleRuntimeSessionTimeout reap the
 * microVM — sessions are per-run, so idle means done.
 */
import { providersFromEnv } from "@agent-os/core";
import { processRun } from "./process-run";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;

let activeRuns = 0;

// Bounded per-run telemetry flush (ADR-0035): same trade as task.ts — a hung
// flush must never keep a paid session alive; the microVM outlives a run only
// until the idle timeout, so flush before declaring the run done.
const flushTelemetry = () =>
  Promise.race([
    providers.telemetry.shutdown?.().catch((e: any) => console.error(`telemetry flush failed: ${e?.message ?? e}`)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);

async function executeRun(runId: string): Promise<void> {
  activeRuns++;
  try {
    await processRun(providers, runId, { maxOutputTokens });
    const run = await providers.runStore.get(runId);
    console.log(`agentcore entrypoint: run ${runId} finished status=${run?.status ?? "unknown"}`);
  } catch (e: any) {
    // processRun owns run-body failures (persists status=failed); this catches
    // crashes outside it — provider build, an unreachable store.
    console.error(`agentcore entrypoint: run ${runId} crashed: ${e?.message ?? String(e)}`);
  } finally {
    await flushTelemetry();
    activeRuns--;
  }
}

const port = Number(process.env.PORT ?? 8080); // Runtime's HTTP contract port

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    // Runtime's probe: HealthyBusy holds the session open for the in-flight run.
    if (req.method === "GET" && url.pathname === "/ping") {
      return Response.json({ status: activeRuns > 0 ? "HealthyBusy" : "Healthy" });
    }
    if (req.method === "POST" && url.pathname === "/invocations") {
      let runId: unknown;
      try {
        runId = ((await req.json()) as { runId?: unknown })?.runId;
      } catch {
        return Response.json({ error: "invalid JSON payload" }, { status: 400 });
      }
      if (typeof runId !== "string" || !runId) {
        return Response.json({ error: "payload must be {runId: string}" }, { status: 400 });
      }
      void executeRun(runId); // fire-and-forget: the ack returns, /ping goes busy
      return Response.json({ accepted: true, runId }, { status: 202 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(
  `agent-runtime on AgentCore Runtime: listening on :${port}  ` +
    `(store=${providers.runStore.name} inference=${providers.inference.name} ` +
    `sandbox=${providers.sandbox.name} guard=${providers.guard.name} record=${providers.telemetry.name})`,
);
