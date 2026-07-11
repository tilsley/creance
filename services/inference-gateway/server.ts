/**
 * Inference gateway (ADR-0019) — the standalone, privileged choke point every model call
 * routes through. It is the sole holder of model credentials (assume-role → Bedrock) and
 * the place budget admission runs; callers (the agent-runtime, or any deployed workload)
 * reach it over HTTP with their own identity and hold no model access themselves.
 *
 * This entrypoint serves the shared handler (app.ts) with Bun.serve — the pod/full-k8s
 * substrate; lambda.ts serves the SAME handler serverless (ADR-0039). Keep it dumb — no
 * agent loop, no tools, no sandbox — so the high-value target has minimal surface (the
 * Copilot-CAPI lesson). Env: PORT (default 3100), plus the usual provider envs (AUTHN,
 * INFERENCE_PROVIDER, TENANT_ASSUME_ROLE, GATE, ...). Do NOT set INFERENCE_GATEWAY_URL
 * here — this process is the gateway, not a client.
 */
import { providersFromEnv } from "@agent-os/core";
import { createGatewayApp } from "./app";

const providers = providersFromEnv();
const app = createGatewayApp(providers);
const port = Number(process.env.PORT ?? 3100);

const server = Bun.serve({
  port,
  fetch: app,
  // fail closed with JSON, never Bun's HTML dev error page — the gateway is a wire
  // endpoint for SDK clients, and the page would leak source context (metadata-only
  // logging: message, not bodies)
  error(e) {
    console.error(`unhandled gateway error: ${(e as Error)?.message}`);
    return Response.json({ error: "internal error" }, { status: 500 });
  },
});

console.log(`inference-gateway listening on :${server.port}  (authn=${providers.authenticator.name})`);
