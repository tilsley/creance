/**
 * Tool gateway (ADR-0011) — tools stop being hardcoded. A ToolProvider assembles
 * the toolset for a run from sources (built-in workspace/http + MCP servers),
 * governed per-tenant, with broker creds injected. The loop stays unchanged: the
 * runtime resolves a ToolSet up front and passes its tools in.
 *
 * The composite-with-policy IS the thin local gateway; a hosted single MCP
 * endpoint (AgentCore Gateway) is the documented swap-in.
 */
import type { AgentTool } from "./tools";
import { workspaceTools, httpRequestTool, callAgentTool } from "./tools";
import type { SandboxSession } from "./ports";
import type { Principal } from "./gate";
import type { CredentialBroker } from "./credentials";

export interface ToolContext {
  principal: Principal;
  session: SandboxSession;
}

export interface ToolSet {
  tools: AgentTool[];
  /** Tear down any connections opened to resolve the tools (e.g. MCP clients). */
  close(): Promise<void>;
}

export interface ToolProvider {
  readonly name: string;
  resolve(ctx: ToolContext): Promise<ToolSet>;
}

/** The tools we ship in-process: the sandbox workspace + the broker-backed http_request. */
export class BuiltinToolProvider implements ToolProvider {
  readonly name = "builtin";
  constructor(private readonly broker: CredentialBroker) {}
  async resolve(ctx: ToolContext): Promise<ToolSet> {
    return {
      tools: [...workspaceTools(ctx.session), httpRequestTool(this.broker, ctx.principal), callAgentTool(this.broker, ctx.principal)],
      close: async () => {},
    };
  }
}

/** Merge several providers into one toolset; close them all afterwards. */
export class CompositeToolProvider implements ToolProvider {
  readonly name = "composite";
  constructor(private readonly providers: ToolProvider[]) {}
  async resolve(ctx: ToolContext): Promise<ToolSet> {
    const sets = await Promise.all(this.providers.map((p) => p.resolve(ctx)));
    return {
      tools: sets.flatMap((s) => s.tools),
      close: async () => {
        for (const s of sets) await s.close().catch(() => {});
      },
    };
  }
}
