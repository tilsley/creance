#!/usr/bin/env bun
/**
 * A tiny, self-contained MCP server (stdio) for the gateway demo — a stand-in for
 * a real MCP server (GitHub, filesystem, an internal service). Exposes one tool,
 * `lookup_order`, with deterministic data. The low-level Server API keeps the
 * inputSchema as plain JSON Schema (no zod).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ORDERS: Record<string, { status: string; carrier: string }> = {
  "ORD-42": { status: "shipped", carrier: "DHL" },
  "ORD-7": { status: "processing", carrier: "—" },
};

const server = new Server({ name: "orders", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "lookup_order",
      description: "Look up the shipping status of an order by its ID.",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string", description: "e.g. ORD-42" } },
        required: ["orderId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const orderId = String((req.params.arguments as any)?.orderId ?? "");
  const order = ORDERS[orderId];
  if (!order) return { content: [{ type: "text", text: `no such order: ${orderId}` }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify({ orderId, ...order }) }] };
});

await server.connect(new StdioServerTransport());
