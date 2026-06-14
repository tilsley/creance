/**
 * Tool gateway (ADR-0011 direction (b), ADR-0029) — the centralized, shared tool/MCP execution
 * path. ADR-0011 built direction (a): each runtime connects to MCP servers itself (McpToolProvider
 * in-process). This is (b): ONE standalone service holds the MCP connections, the per-tenant policy,
 * and the broker credentials, and every agent resolves + invokes its tools through it. 50 agents
 * share one Slack MCP server, not 50; the agent pod holds no tool credential and opens no tool
 * connection — the same extraction the inference gateway did for `think`, now for `do`'s tool face.
 *
 * Reuses providersFromEnv (authn + the credential broker); builds the McpToolProvider from
 * MCP_SERVERS. Keep it dumb — no agent loop, no sandbox — so the high-value target (it holds the
 * tool creds) has minimal surface. Env: PORT (default 3200), AUTHN, CRED_BROKER, MCP_SERVERS.
 */
import { providersFromEnv, McpToolProvider } from "@agent-os/core";
import type { McpServers, Principal, SandboxSession } from "@agent-os/core";
import { handleToolsList, handleToolsCall, type ToolGatewayDeps } from "./tools-api";

const { authenticator, credentials } = providersFromEnv();
const port = Number(process.env.PORT ?? 3200);

// the gateway serves EXTERNAL tools only (MCP servers) — never the sandbox/workspace tools, which
// stay in the agent's own sandbox (do-execution). MCP resolution needs no session, so we pass a
// stub that throws if a sandbox tool ever sneaks in.
const servers: McpServers = process.env.MCP_SERVERS ? JSON.parse(process.env.MCP_SERVERS) : {};
const mcp = new McpToolProvider(servers, credentials);
const noSandbox = new Proxy({}, { get() { throw new Error("the tool gateway serves no sandbox tools"); } }) as SandboxSession;

const deps: ToolGatewayDeps = {
  authenticator,
  resolveTools: (principal: Principal) => mcp.resolve({ principal, session: noSandbox }),
};

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (req.method === "POST" && url.pathname === "/tools/list") return handleToolsList(req, deps);
    if (req.method === "POST" && url.pathname === "/tools/call") return handleToolsCall(req, deps);
    return new Response("not found", { status: 404 });
  },
  // fail closed with JSON, never Bun's HTML dev error page (it would leak source context)
  error(e) {
    console.error(`unhandled tool-gateway error: ${(e as Error)?.message}`);
    return Response.json({ error: "internal error" }, { status: 500 });
  },
});

console.log(
  `tool-gateway listening on :${server.port}  (authn=${authenticator.name}, broker=${credentials.name}, servers=${Object.keys(servers).join(",") || "none"})`,
);
