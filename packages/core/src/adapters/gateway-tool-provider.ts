/**
 * GatewayToolProvider — the client side of the centralized tool/MCP gateway (ADR-0011 direction
 * (b), ADR-0029). Instead of every runtime connecting to MCP servers itself (`McpToolProvider`
 * in-process — a fresh subprocess/connection per run, the tool creds in each agent), it resolves
 * its toolset from ONE shared gateway that holds the MCP connections, the per-tenant policy, and
 * the broker credentials. The agent forwards only its identity — it never connects to a tool
 * server and never holds a tool credential. The same extraction the inference gateway did for
 * `think`, now for `do`'s tool face: the agent stays credential-less; one place governs + audits.
 *
 *   resolve   → POST /tools/list  (Bearer = caller identity)  → ToolDef[]   (already tenant-filtered)
 *   tool.run  → POST /tools/call  {name, input}               → { output }
 */
import type { ToolProvider, ToolSet, ToolContext } from "../tool-gateway";
import type { AgentTool } from "../tools";
import type { ToolDef } from "../ports";

export class GatewayToolProvider implements ToolProvider {
  readonly name = "gateway-tools";
  constructor(private readonly url: string) {}

  async resolve(ctx: ToolContext): Promise<ToolSet> {
    const base = this.url.replace(/\/$/, "");
    // forward the caller's identity; the gateway authenticates it and derives the tenant itself,
    // applies the per-tenant allowlist, and returns only the tools this tenant may use.
    const auth: Record<string, string> = ctx.principal.token ? { authorization: `Bearer ${ctx.principal.token}` } : {};

    const res = await fetch(`${base}/tools/list`, { method: "POST", headers: auth });
    if (!res.ok) {
      throw new Error(`tool gateway /tools/list: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
    }
    const { tools = [] } = (await res.json()) as { tools: ToolDef[] };

    const agentTools: AgentTool[] = tools.map((spec) => ({
      spec,
      run: async (input: Record<string, unknown>) => {
        const r = await fetch(`${base}/tools/call`, {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ name: spec.name, input }),
        });
        const j = (await r.json().catch(() => ({}))) as { output?: string; error?: string };
        if (!r.ok) return `error: tool gateway ${r.status}: ${j.error ?? "(no detail)"}`;
        return j.output ?? j.error ?? "(no output)";
      },
    }));

    // nothing to tear down here — the gateway owns the MCP connections, not us.
    return { tools: agentTools, close: async () => {} };
  }
}
