/**
 * agent-runtime task — the L1 loop as a Fargate task-per-run (ADR-0031).
 *
 * The serverless substrate splits the always-on service (server.ts) into a front
 * door (the router: authn → authz → budget → create the queued Run → dispatch)
 * and this executor: run ONE Run to a terminal state, then exit. The container
 * lives only for the life of the run — that's the scale-to-zero / ~$0-idle win.
 *
 * The run id arrives as RUN_ID (the ECS RunTask env override) or the first CLI
 * arg. Providers come from the SAME env wiring as the service, so the run body
 * (process-run.ts) is byte-identical to the in-process worker — only the
 * lifecycle differs.
 *
 *   RUN_ID=<uuid> bun run services/agent-runtime/task.ts
 */
import { providersFromEnv } from "@agent-os/core";
import { processRun } from "./process-run";

const runId = process.env.RUN_ID ?? process.argv[2];
if (!runId) {
  console.error("agent-runtime task: no run id (set RUN_ID or pass it as the first arg)");
  process.exit(2);
}

const providers = providersFromEnv(); // once per process (OTel registers globally)
// per-turn output cap (ADR-0013); undefined -> the loop's built-in default
const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;

console.log(
  `agent-runtime task: processing run ${runId}  ` +
    `(store=${providers.runStore.name} inference=${providers.inference.name} ` +
    `sandbox=${providers.sandbox.name} guard=${providers.guard.name} record=${providers.telemetry.name})`,
);

// processRun owns its own failures (it persists status=failed on a thrown run); this
// try/catch is the backstop for a crash *outside* the run body — provider build, a
// missing run id, an unreachable store. The exit code mirrors the terminal status so
// ECS surfaces a real failure as a non-zero task exit.
try {
  await processRun(providers, runId, { maxOutputTokens });
  const run = await providers.runStore.get(runId);
  console.log(`agent-runtime task: run ${runId} finished status=${run?.status ?? "unknown"}`);
  // TODO(ADR-0031 open): flush the OTel batch span processor before exit — process.exit
  // can drop the last spans. We exit hard regardless because a hung task burns money,
  // which for a cost-sensitive POC is worse than a few lost spans. Revisit with a
  // telemetry shutdown() hook + a bounded flush timeout.
  process.exit(run?.status === "failed" ? 1 : 0);
} catch (e: any) {
  console.error(`agent-runtime task: run ${runId} crashed: ${e?.message ?? String(e)}`);
  process.exit(1);
}
