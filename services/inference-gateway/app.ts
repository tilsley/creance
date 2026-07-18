/**
 * createGatewayApp — the gateway's HTTP surface as a single `(Request) => Response`
 * handler, independent of what SERVES it (ADR-0039, the seam ADR-0031 cut for the
 * runtime applied here):
 *   - server.ts  serves it with Bun.serve       (pod, full-k8s)
 *   - lambda.ts  serves it via the Lambda Runtime API loop (serverless)
 * Routes, authn, admission, and both wires (bespoke /v1/generate + Anthropic
 * /v1/messages, ADR-0028) are identical across substrates.
 */
import { withCors, type Providers } from "@agent-os/core";
import { handleGenerate } from "./generate";
import { handleCreateClaim } from "./claims";
import { handleMessages } from "./messages";
import { BedrockAnthropicUpstream } from "./bedrock-anthropic";

export function createGatewayApp(providers: Providers): (req: Request) => Promise<Response> {
  const { authenticator, inferenceForTenant, claimSource, claimWrite, gate, tenantCredentials } = providers;

  // MODEL_ALIASES maps claim/client model names to Bedrock ids, e.g.
  // {"claude-haiku":"eu.anthropic.claude-haiku-4-5-20251001-v1:0"}; an unmapped name passes
  // through as-is, no name at all falls back to MODEL_ID. Applied on BOTH wires (ADR-0028).
  const aliases: Record<string, string> = process.env.MODEL_ALIASES ? JSON.parse(process.env.MODEL_ALIASES) : {};
  const resolveModel = (m?: string): string | undefined => (m ? (aliases[m] ?? m) : process.env.MODEL_ID);

  // route each caller to the model named on its claim (ADR-0021), resolved through the alias map
  const modelFor = claimSource
    ? (sa: string) => claimSource.forServiceAccount(sa).then((c) => resolveModel(c?.model))
    : undefined;

  const messagesDeps = {
    authenticator,
    gate,
    upstream: new BedrockAnthropicUpstream(process.env.REGION ?? "eu-west-2", tenantCredentials),
    claimFor: claimSource ? (sa: string) => claimSource.forServiceAccount(sa) : undefined,
    resolveModel,
  };

  // CORS is app-owned (ADR-0043) — identical behavior on pod, Lambda, and edge.
  return withCors(async function handle(req: Request): Promise<Response> {
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
  });
}
