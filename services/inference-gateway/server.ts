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
import { handleCreateClaim } from "./claims";
import { handleMessages } from "./messages";
import { BedrockAnthropicUpstream } from "./bedrock-anthropic";

const providers = providersFromEnv();
const { authenticator, inferenceForTenant, claimSource, claimWrite, gate, tenantCredentials } = providers;
const port = Number(process.env.PORT ?? 3100);

// MODEL_ALIASES maps claim/client model names to Bedrock ids, e.g.
// {"claude-haiku":"eu.anthropic.claude-haiku-4-5-20251001-v1:0"}; an unmapped name passes
// through as-is, no name at all falls back to MODEL_ID. Applied on BOTH wires (ADR-0028) so a
// claim can name a friendly alias regardless of which endpoint serves it — without it the
// bespoke /v1/generate path handed the raw alias to Bedrock ("invalid model identifier").
const aliases: Record<string, string> = process.env.MODEL_ALIASES ? JSON.parse(process.env.MODEL_ALIASES) : {};
const resolveModel = (m?: string): string | undefined => (m ? (aliases[m] ?? m) : process.env.MODEL_ID);

// route each caller to the model named on its claim (ADR-0021), resolved through the alias map
const modelFor = claimSource ? (sa: string) => claimSource.forServiceAccount(sa).then((c) => resolveModel(c?.model)) : undefined;

const messagesDeps = {
  authenticator,
  gate,
  upstream: new BedrockAnthropicUpstream(process.env.REGION ?? "eu-west-2", tenantCredentials),
  claimFor: claimSource ? (sa: string) => claimSource.forServiceAccount(sa) : undefined,
  resolveModel,
};

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (req.method === "POST" && url.pathname === "/v1/generate") {
      return handleGenerate(req, { authenticator, inferenceForTenant, modelFor });
    }
    // Anthropic wire (ADR-0028): unmodified Anthropic clients (Claude Code, OpenCode/@ai-sdk)
    // get governed inference — verified identity → claim → reserve → Bedrock passthrough → settle
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      return handleMessages(req, messagesDeps);
    }
    // self-service onboarding (ADR-0021): a service registers its own grant (tenant = identity)
    if (req.method === "POST" && url.pathname === "/claims") {
      if (!claimWrite) return Response.json({ error: "self-service claims not enabled" }, { status: 404 });
      return handleCreateClaim(req, claimWrite);
    }
    return new Response("not found", { status: 404 });
  },
  // fail closed with JSON, never Bun's HTML dev error page — the gateway is a wire
  // endpoint for SDK clients, and the page would leak source context (metadata-only
  // logging: message, not bodies)
  error(e) {
    console.error(`unhandled gateway error: ${(e as Error)?.message}`);
    return Response.json({ error: "internal error" }, { status: 500 });
  },
});

console.log(`inference-gateway listening on :${server.port}  (authn=${authenticator.name})`);
