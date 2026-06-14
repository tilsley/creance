/**
 * The tool gateway's HTTP handlers (ADR-0011 direction (b), ADR-0029), factored out of the server
 * so they're unit-testable with mock deps (mirrors services/inference-gateway/generate.ts).
 *
 * The centralized tool/MCP execution path: it authenticates the caller, derives the tenant from
 * that proven identity, resolves the tenant's permitted tools (per-tenant allowlist + broker creds,
 * held HERE not in the caller), and lists/executes them. The MCP connections and the tool
 * credentials never leave this process — a caller forwards only its identity.
 *
 *   POST /tools/list  → { tools: ToolDef[] }     the tenant's permitted tools (already filtered)
 *   POST /tools/call  → { output } | { error }   execute one, server-side, with creds injected
 */
import type { Authenticator, Principal, ToolSet } from "@agent-os/core";
import { UnauthorizedError } from "@agent-os/core";

export interface ToolGatewayDeps {
  authenticator: Authenticator;
  /** resolve the tenant's permitted toolset (the McpToolProvider, with no sandbox session). */
  resolveTools: (principal: Principal) => Promise<ToolSet>;
}

const bearer = (req: Request): string | undefined => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

/** authenticate → Principal, or a 401 Response the caller should return as-is. */
async function authenticate(req: Request, deps: ToolGatewayDeps): Promise<Principal | Response> {
  try {
    return await deps.authenticator.authenticate({ credential: bearer(req), headers: Object.fromEntries(req.headers) });
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function handleToolsList(req: Request, deps: ToolGatewayDeps): Promise<Response> {
  const principal = await authenticate(req, deps);
  if (principal instanceof Response) return principal;
  const set = await deps.resolveTools(principal);
  try {
    // resolve already applied the per-tenant allowlist + credential default-deny, so this is
    // exactly the tools this tenant may use — names namespaced `server__tool`.
    return Response.json({ tools: set.tools.map((t) => t.spec) });
  } finally {
    await set.close().catch(() => {});
  }
}

export async function handleToolsCall(req: Request, deps: ToolGatewayDeps): Promise<Response> {
  const principal = await authenticate(req, deps);
  if (principal instanceof Response) return principal;

  let body: { name?: string; input?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = String(body.name ?? "");
  if (!name) return Response.json({ error: "missing 'name'" }, { status: 400 });

  const set = await deps.resolveTools(principal);
  try {
    // policy is structural: a tool absent from the resolved set is one this tenant may not use
    // (or doesn't exist) — same 404 either way, we don't leak which.
    const tool = set.tools.find((t) => t.spec.name === name);
    if (!tool) {
      return Response.json({ error: `tool '${name}' not found or not permitted for tenant '${principal.tenant}'` }, { status: 404 });
    }
    const output = await tool.run((body.input ?? {}) as Record<string, unknown>);
    return Response.json({ output });
  } catch (e) {
    return Response.json({ error: "tool execution failed", detail: (e as Error)?.message }, { status: 500 });
  } finally {
    await set.close().catch(() => {});
  }
}
