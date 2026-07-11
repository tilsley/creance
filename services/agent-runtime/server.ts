/**
 * agent-runtime — the L1 runtime as an HTTP service (the "front door"), async +
 * gated. Serves the shared request handler (app.ts) with Bun.serve; the same
 * handler runs on Lambda via lambda.ts (ADR-0031) — only the server differs.
 *
 * A run is a first-class, persisted entity (the State primitive — core/runs),
 * scoped by the `gate` control (identity + budget — ADR-0009):
 *   POST /runs  {"task":"..."}  -> 202 { runId, status:"queued", tenant }
 *     Authorization: Bearer <token>  (under GATE=local; open under the default)
 *   GET  /runs/{id}                 -> the Run { status, messages, output?, usage, costUsd }
 *   GET  /tenants/{tenant}/budget   -> { limitUsd, spentUsd, remainingUsd, ok }
 *   GET  /tenants/{tenant}/usage    -> { period, budget:{...}, quota:{ limit, used, remaining, ok } }
 *   GET  /healthz                   -> { status: "ok" }
 *
 * The dispatch strategy is picked by env (ADR-0031): DISPATCH=inprocess runs an
 * in-process worker here (full-k8s); DISPATCH=runtask makes this the serverless
 * front door, launching a Fargate task-per-run.
 *
 *   GATE=local GATE_TOKENS="tok:teamA:alice" GATE_BUDGET_USD=1.00 bun run start
 */
import { providersFromEnv } from "@agent-os/core";
import { createApp } from "./app";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const { gate, authenticator, authorizer, runStore: store, agentRegistry } = providers;
const port = Number(process.env.PORT ?? 3000);
// per-turn output cap (ADR-0013); undefined -> the loop's built-in default
const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;

const app = createApp(providers, { maxOutputTokens, a2aAgent: process.env.A2A_AGENT });
const server = Bun.serve({ port, fetch: app });

console.log(
  `agent-runtime listening on :${server.port}  (async; dispatch=${process.env.DISPATCH ?? "inprocess"}; ` +
    `store=${store.name}; gate=${gate.name}; ` +
    `authn=${authenticator.name} authz=${authorizer.name}; ` +
    `inference=${providers.inference.name} sandbox=${providers.sandbox.name} ` +
    `guard=${providers.guard.name} record=${providers.telemetry.name})`,
);
