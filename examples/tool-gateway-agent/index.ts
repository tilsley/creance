#!/usr/bin/env bun
/**
 * Tool-gateway e2e — an agent that runs through BOTH choke points (ADR-0029):
 *   think → the inference gateway → Bedrock      (the agent decides to call a tool)
 *   tools → the centralized tool gateway → MCP    (the agent never connects to the MCP server)
 *
 * The agent holds no model creds and no tool creds — only its projected SA token, forwarded to
 * both gateways, which each verify it and derive the tenant. It resolves its toolset from the tool
 * gateway (GatewayToolProvider, via TOOL_GATEWAY_URL) and answers an order-status question by
 * calling the gateway-fronted MCP tool. Proves the two governed-egress planes compose.
 *
 * Env: INFERENCE_GATEWAY_URL, TOOL_GATEWAY_URL, AGENT_TOKEN(_FILE), AGENT_TENANT, MODEL_ID.
 */
import { readFileSync } from "node:fs";
import { providersFromEnv, runOnSession, type ToolContext } from "@agent-os/core";

const token =
  process.env.AGENT_TOKEN ??
  (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, "utf8").trim() : undefined);
const tenant = process.env.AGENT_TENANT ?? "teamA";
const model = process.env.MODEL_ID ?? "claude-haiku";
const task =
  process.argv.slice(2).join(" ") ||
  "What is the shipping status and carrier for order ORD-42? Use the orders lookup tool, then report the status and carrier in one short line and stop.";

const providers = providersFromEnv();
const runId = `tg-${Date.now()}`;
const session = await providers.sandbox.startSession();

// resolve the toolset for this identity — the external tools come from the tool gateway, which
// authenticates the forwarded token, applies the per-tenant allowlist, and returns the permitted tools.
const ctx: ToolContext = { principal: { tenant, subject: "agent", token }, session };
const toolset = await providers.toolProvider.resolve(ctx);
const inference = await providers.inferenceForTenant(tenant, token, runId, model);

console.log(`▶ tool-gateway agent — tenant=${tenant}`);
console.log(`  think via ${process.env.INFERENCE_GATEWAY_URL ?? "(direct)"}  ·  tools via ${process.env.TOOL_GATEWAY_URL ?? "(in-process)"}`);
console.log(`  toolset: ${toolset.tools.map((t) => t.spec.name).join(", ")}`);
console.log(`  task: "${task}"\n`);

let result;
try {
  result = await runOnSession({
    inference,
    guard: providers.guard,
    telemetry: providers.telemetry,
    session,
    tools: () => toolset.tools,
    systemPrompt:
      "Use your tools to answer. To check an order, call the orders lookup tool with the order id. " +
      "Report the status and carrier in one short line, then STOP — no extra tool calls.",
    task,
    maxSteps: 6,
    maxOutputTokens: 512,
  });
} finally {
  await toolset.close();
  await session.close();
}

console.log(`\n✅ status=${result.status}`);
console.log(`   output: ${result.output ?? "(none)"}`);
console.log(`   usage:  in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"} tokens`);
if (result.status !== "completed") process.exit(1);
