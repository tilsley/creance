/**
 * McpToolProvider — connects to configured MCP servers, discovers their tools, and
 * surfaces each as an AgentTool (ADR-0011). MCP is the integration protocol: we
 * plug in arbitrary tools (GitHub, filesystem, an internal service) without an
 * adapter per tool.
 *
 * Per server: a per-tenant allowlist (policy), and an optional credentialTarget —
 * the CredentialBroker mints a scoped credential injected into the server (env for
 * stdio, Authorization header for HTTP). The secret never reaches the model. Tool
 * names are namespaced `server__tool` to avoid collisions and enable policy.
 *
 *   MCP_SERVERS='{"github":{"transport":"http","url":"https://api.githubcopilot.com/mcp/","tenants":["teamA"],"credentialTarget":"github","credentialEnv":""}}'
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolProvider, ToolSet, ToolContext } from "../tool-gateway";
import type { AgentTool } from "../tools";
import type { CredentialBroker } from "../credentials";

export interface McpServerConfig {
  transport: "stdio" | "http";
  /** stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  /** http */
  url?: string;
  /** Policy: tenants allowed to use this server. Omitted ⇒ open to all. */
  tenants?: string[];
  /** Optional broker target whose credential is injected into the server. */
  credentialTarget?: string;
  /** Env var to carry the credential for stdio servers (e.g. "GITHUB_TOKEN"). */
  credentialEnv?: string;
}

export type McpServers = Record<string, McpServerConfig>;

const stringEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
};

export class McpToolProvider implements ToolProvider {
  readonly name = "mcp";
  constructor(
    private readonly servers: McpServers,
    private readonly broker: CredentialBroker,
  ) {}

  async resolve(ctx: ToolContext): Promise<ToolSet> {
    const clients: Client[] = [];
    const tools: AgentTool[] = [];

    for (const [serverName, cfg] of Object.entries(this.servers)) {
      // policy: per-tenant allowlist (default-open if no list given)
      if (cfg.tenants && !cfg.tenants.includes(ctx.principal.tenant)) continue;

      // gate: mint a scoped credential for this server, if configured
      let token: string | undefined;
      let scheme: "bearer" | "header" = "bearer";
      let header: string | undefined;
      if (cfg.credentialTarget) {
        const cred = await this.broker.issue(ctx.principal, cfg.credentialTarget);
        if (!cred) continue; // not granted → skip the server entirely (default deny)
        token = cred.token;
        scheme = cred.scheme;
        header = cred.header;
      }

      const transport =
        cfg.transport === "stdio"
          ? new StdioClientTransport({
              command: cfg.command!,
              args: cfg.args ?? [],
              cwd: cfg.cwd,
              env: token && cfg.credentialEnv ? { ...stringEnv(), [cfg.credentialEnv]: token } : stringEnv(),
            })
          : new StreamableHTTPClientTransport(new URL(cfg.url!), {
              requestInit: token
                ? { headers: { [header ?? "authorization"]: scheme === "bearer" ? `Bearer ${token}` : token } }
                : undefined,
            });

      const client = new Client({ name: "agent-os-runtime", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
      clients.push(client);

      const { tools: mcpTools } = await client.listTools();
      for (const t of mcpTools) {
        tools.push({
          spec: {
            name: `${serverName}__${t.name}`,
            description: t.description ?? `${t.name} (via ${serverName})`,
            inputSchema: t.inputSchema as Record<string, unknown>,
          },
          run: async (input) => {
            const res: any = await client.callTool({ name: t.name, arguments: input });
            const text = (res.content ?? [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
            return res.isError ? `error: ${text || "tool reported an error"}` : text || "(no output)";
          },
        });
      }
    }

    return {
      tools,
      close: async () => {
        for (const c of clients) await c.close().catch(() => {});
      },
    };
  }
}
