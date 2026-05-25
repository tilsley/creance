#!/usr/bin/env bun
/**
 * Tool/MCP gateway demo (ADR-0011) — tools come from an MCP server, not hardcoded.
 *
 * Configures one MCP server (the local mock `orders` server, over stdio) granted
 * to teamA only, then shows:
 *   1. teamA's toolset includes the discovered, namespaced MCP tool (orders__lookup_order),
 *   2. teamB's does not (per-tenant policy), and
 *   3. the agent (teamA) actually calls the MCP tool to answer.
 *
 *   bun run start            (needs Bedrock creds + model access)
 */
import { providersFromEnv, runOnSession, type ToolContext } from "@agent-os/core";

// configure the gateway: the mock MCP server, spawned via bun, granted to teamA
process.env.MCP_SERVERS = JSON.stringify({
  orders: {
    transport: "stdio",
    command: "bun",
    args: ["run", import.meta.dir + "/mock-mcp-server.ts"],
    tenants: ["teamA"],
  },
});

const { inference, guard, telemetry, sandbox, toolProvider } = providersFromEnv();

const sessionFor = async (tenant: string) => {
  const session = await sandbox.startSession();
  const ctx: ToolContext = { principal: { tenant, subject: "demo" }, session };
  const set = await toolProvider.resolve(ctx);
  const names = set.tools.map((t) => t.spec.name);
  await set.close();
  await session.close();
  return names;
};

// 1 + 2: policy — teamA sees the MCP tool, teamB doesn't
console.log("teamA tools:", (await sessionFor("teamA")).join(", "));
console.log("teamB tools:", (await sessionFor("teamB")).join(", "));

// 3: run the agent as teamA, which must use the discovered MCP tool
const session = await sandbox.startSession();
const ctx: ToolContext = { principal: { tenant: "teamA", subject: "alice" }, session };
const toolset = await toolProvider.resolve(ctx);
try {
  const result = await runOnSession({
    inference,
    guard,
    telemetry,
    session,
    tools: () => toolset.tools,
    maxSteps: 6,
    systemPrompt:
      "Use your tools to answer. To check an order, call the orders lookup tool. Report the result and STOP.",
    task: "What is the shipping status and carrier for order ORD-42?",
  });
  console.log(`\nstatus: ${result.status}`);
  console.log(`agent answer: ${result.output?.replace(/\s+/g, " ").trim().slice(0, 200)}`);
} finally {
  await toolset.close();
  await session.close();
}
