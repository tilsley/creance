/**
 * Inference gateway (ADR-0019) — the standalone, privileged choke point every model call
 * routes through. It is the sole holder of model credentials (assume-role → Bedrock) and
 * the place budget admission runs; callers (the agent-runtime, or any deployed workload)
 * reach it over HTTP with their own identity and hold no model access themselves.
 *
 * Reuses the same provider wiring as the runtime (providersFromEnv): authn verifies the
 * caller, inferenceForTenant assumes the tenant role + wraps budget admission. Keep it
 * dumb — no agent loop, no tools, no sandbox — so the high-value target has minimal
 * surface (the Copilot-CAPI lesson). Env: PORT (default 3100), plus the usual provider
 * envs (AUTHN, INFERENCE_PROVIDER, TENANT_ASSUME_ROLE, GATE, ...). Do NOT set
 * INFERENCE_GATEWAY_URL here — this process is the gateway, not a client.
 */
import { providersFromEnv } from "@agent-os/core";
import { handleGenerate } from "./generate";

const providers = providersFromEnv();
const { authenticator, inferenceForTenant } = providers;
const port = Number(process.env.PORT ?? 3100);

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (req.method === "POST" && url.pathname === "/v1/generate") {
      return handleGenerate(req, { authenticator, inferenceForTenant });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`inference-gateway listening on :${server.port}  (authn=${authenticator.name})`);
