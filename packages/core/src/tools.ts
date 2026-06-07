/**
 * Agent tools — the things the model can call. A tool is a JSON-schema spec +
 * a handler. `workspaceTools` exposes the Sandbox workspace (run/read/write/list)
 * to the model, which is what lets an agent investigate and edit a repo.
 */
import type { SandboxSession, ToolDef } from "./ports";
import type { CredentialBroker } from "./credentials";
import type { Principal } from "./gate";

export interface AgentTool {
  spec: ToolDef;
  run(input: Record<string, unknown>): Promise<string>;
}

/**
 * An authenticated outbound HTTP tool (ADR-0010). The model names a `target`; the
 * platform asks the CredentialBroker for that principal's scoped credential and
 * applies it server-side. The model never sees the secret, and can only reach
 * targets the broker grants (default deny) at the allowlisted baseUrl.
 */
export function httpRequestTool(broker: CredentialBroker, principal: Principal): AgentTool {
  return {
    spec: {
      name: "http_request",
      description:
        "Make an authenticated HTTP request to an allowlisted external target. " +
        "Credentials are attached by the platform — you never see, provide, or need them. " +
        "Args: target (e.g. 'github'), path (e.g. '/user'), method (default GET), body (optional).",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "The granted downstream system, e.g. 'github'." },
          path: { type: "string", description: "Path appended to the target's base URL." },
          method: { type: "string", description: "HTTP method (default GET)." },
          body: { type: "string", description: "Request body, for POST/PUT/PATCH." },
        },
        required: ["target", "path"],
      },
    },
    run: async (i) => {
      const target = String(i.target ?? "");
      const cred = await broker.issue(principal, target);
      if (!cred) return `error: no access to target '${target}' for tenant '${principal.tenant}'`;
      if (!cred.baseUrl) return `error: target '${target}' has no endpoint configured`;
      if (cred.expiresAt && Date.parse(cred.expiresAt) < Date.now()) return `error: credential for '${target}' expired`;

      const url = cred.baseUrl.replace(/\/$/, "") + "/" + String(i.path ?? "").replace(/^\//, "");
      const headers: Record<string, string> = { accept: "application/json" };
      if (cred.scheme === "bearer") headers.authorization = `Bearer ${cred.token}`;
      else headers[cred.header ?? "x-api-key"] = cred.token; // secret stays server-side

      try {
        const method = String(i.method ?? "GET").toUpperCase();
        const res = await fetch(url, {
          method,
          headers,
          body: i.body != null && method !== "GET" ? String(i.body) : undefined,
        });
        const text = await res.text();
        return `HTTP ${res.status}\n${text.slice(0, 4000)}`; // body only — never the credential
      } catch (e: any) {
        return `error: request failed: ${e?.message ?? String(e)}`;
      }
    },
  };
}

/**
 * Agent-to-agent delegation tool (ADR-0017/0018), speaking the standard A2A protocol.
 * The model names another `agent`; the platform brokers an on-behalf-of credential
 * (extending the delegation chain), discovers the target via its Agent Card, and
 * invokes it over A2A JSON-RPC (message/send → poll tasks/get), forwarding the
 * propagated identity in the standard Authorization header. The model never handles
 * credentials, and can only reach agents the broker grants.
 */
export function callAgentTool(broker: CredentialBroker, principal: Principal): AgentTool {
  const TERMINAL = ["completed", "failed", "canceled"]; // A2A TaskState terminals
  return {
    spec: {
      name: "call_agent",
      description:
        "Delegate a task to another agent (A2A). The platform forwards your identity on-behalf-of " +
        "(extending the delegation chain) — you never handle credentials. " +
        "Args: agent (target agent name, must be granted), task (what it should do).",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "The downstream agent to call." },
          task: { type: "string", description: "The task for that agent." },
        },
        required: ["agent", "task"],
      },
    },
    run: async (i) => {
      const agent = String(i.agent ?? "");
      const cred = await broker.issue(principal, agent); // OBO token carrying this caller's chain
      if (!cred) return `error: no access to agent '${agent}' for tenant '${principal.tenant}'`;
      if (!cred.baseUrl) return `error: agent '${agent}' has no endpoint configured`;
      const base = cred.baseUrl.replace(/\/$/, "");
      const auth = { "content-type": "application/json", authorization: `Bearer ${cred.token}` }; // A2A standard auth
      const rpc = (method: string, params: unknown) =>
        fetch(a2aUrl, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }) });

      // A2A discovery: resolve the JSON-RPC endpoint from the Agent Card (default {base}/a2a)
      let a2aUrl = `${base}/a2a`;
      try {
        const card = await fetch(`${base}/.well-known/agent-card.json`);
        if (card.ok) {
          const c = (await card.json()) as { url?: string };
          if (c?.url) a2aUrl = c.url;
        }
      } catch {}

      try {
        const send = await rpc("message/send", {
          message: { role: "user", parts: [{ kind: "text", text: String(i.task ?? "") }], messageId: crypto.randomUUID(), kind: "message" },
          metadata: { agent },
        });
        if (send.status === 401 || send.status === 403) return `error: A2A '${agent}' rejected the call: HTTP ${send.status}`;
        const sent = (await send.json()) as { result?: { id?: string }; error?: { message?: string } };
        if (sent.error) return `error: A2A '${agent}': ${sent.error.message}`;
        const taskId = sent.result?.id;
        if (!taskId) return `error: A2A '${agent}': no task id returned`;

        for (let n = 0; n < 60; n++) {
          await new Promise((r) => setTimeout(r, 1000));
          const got = await rpc("tasks/get", { id: taskId });
          if (!got.ok) continue;
          const task = ((await got.json()) as { result?: any }).result;
          if (task && TERMINAL.includes(task.status?.state)) {
            const text = (task.artifacts ?? [])
              .flatMap((a: any) => a.parts ?? [])
              .filter((p: any) => p?.kind === "text")
              .map((p: any) => p.text)
              .join("\n");
            return `agent '${agent}' -> ${task.status.state}: ${text || "(no output)"}`;
          }
        }
        return `error: agent '${agent}' timed out`;
      } catch (e: any) {
        return `error: call_agent (A2A) failed: ${e?.message ?? String(e)}`;
      }
    },
  };
}

// --- web research: a guarded, SSRF-safe fetch tool (ADR-0008/0011; Model A) -------
// In Model A the loop is a TRUSTED app; research is a tool it calls, executed HERE
// (in the runtime, outside the zero-egress sandbox). The tool returns fetched text;
// the loop screens it via guard as untrusted ingress (loop.ts) — fetched pages are
// the indirect-injection vector. THIS tool owns the *egress policy*: only public
// http(s), never private/loopback/metadata addresses (SSRF — the runtime has the
// network the sandbox doesn't), and an optional per-tenant domain allowlist. In the
// full deployment the runtime also sits behind the egress proxy (slice 2), so the
// allowlist is enforced twice — app-layer here, network-layer there.

const BLOCKED_HOSTNAME = /^(localhost|.*\.local|.*\.localhost)$/i;

/** True for hosts a research fetch must never reach: localhost + private / loopback /
 *  link-local / cloud-metadata (169.254.169.254) IP literals. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip ipv6 brackets
  if (!h || BLOCKED_HOSTNAME.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // ipv6 loopback/ULA/link-local
  return false;
}

/** Validate a URL is safe to fetch for research, or throw. Public http(s) only, no
 *  private/metadata host, and within the per-tenant allowlist when one is set. */
export function assertFetchable(rawUrl: string, allowDomains?: string[]): URL {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error(`invalid url: ${rawUrl}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked scheme: ${u.protocol}`);
  if (isBlockedHost(u.hostname)) throw new Error(`blocked host (private/metadata/loopback): ${u.hostname}`);
  if (allowDomains?.length) {
    const ok = allowDomains.some((d) => u.hostname === d || u.hostname.endsWith("." + d));
    if (!ok) throw new Error(`host not in research allowlist: ${u.hostname}`);
  }
  return u;
}

export interface WebResearchOptions {
  /** Per-tenant fetchable domains; empty/undefined ⇒ any public host (still SSRF-guarded). */
  allowDomains?: string[];
  /** Body cap returned to the model (default 8000 bytes). */
  maxBytes?: number;
  /** Optional search backend (Tavily/Brave/MCP/…). When given, exposes `web_search`. */
  search?: (query: string) => Promise<string>;
}

/** `fetch_url` — GET a public page, return its text (SSRF-guarded, allowlisted, capped).
 *  Refuses redirects so a public URL can't 302 into a private one. */
export function fetchUrlTool(opts: WebResearchOptions = {}): AgentTool {
  const maxBytes = opts.maxBytes ?? 8000;
  return {
    spec: {
      name: "fetch_url",
      description:
        "Fetch a PUBLIC web page (http/https) and return its text for research. Private, " +
        "loopback, and cloud-metadata addresses are refused; the platform screens the " +
        "returned content for safety. Args: url.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Public http(s) URL to fetch." } },
        required: ["url"],
      },
    },
    run: async (i) => {
      let u: URL;
      try { u = assertFetchable(String(i.url ?? ""), opts.allowDomains); }
      catch (e: any) { return `error: ${e.message}`; }
      try {
        const res = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { accept: "text/*, */*" } });
        const body = (await res.text()).slice(0, maxBytes);
        return `HTTP ${res.status} ${u.hostname}\n${body}`;
      } catch (e: any) {
        return `error: fetch failed: ${e?.message ?? String(e)}`;
      }
    },
  };
}

/** `web_search` — a thin wrapper over an injected backend (we don't build search). */
export function webSearchTool(search: (query: string) => Promise<string>): AgentTool {
  return {
    spec: {
      name: "web_search",
      description: "Search the web and return result snippets for research. Args: query.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    run: async (i) => {
      try { return await search(String(i.query ?? "")); }
      catch (e: any) { return `error: search failed: ${e?.message ?? String(e)}`; }
    },
  };
}

/** The research tool set: fetch_url always; web_search when a backend is configured. */
export function webResearchTools(opts: WebResearchOptions = {}): AgentTool[] {
  const tools: AgentTool[] = [fetchUrlTool(opts)];
  if (opts.search) tools.push(webSearchTool(opts.search));
  return tools;
}

export function runCodeTool(session: SandboxSession): AgentTool {
  return {
    spec: {
      name: "run_code",
      description: "Execute Python code in the workspace and return its stdout.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string", description: "Python source." } },
        required: ["code"],
      },
    },
    run: (input) => session.runCode(String(input.code ?? "")),
  };
}

/** The full workspace as tools: run_cmd, read_file, write_file, list_files, run_code. */
export function workspaceTools(session: SandboxSession): AgentTool[] {
  return [
    {
      spec: {
        name: "run_cmd",
        description: "Run a shell command in the workspace. Returns exit code, stdout, stderr.",
        inputSchema: {
          type: "object",
          properties: { cmd: { type: "string", description: "Shell command." } },
          required: ["cmd"],
        },
      },
      run: async (i) => {
        const r = await session.runCmd(String(i.cmd ?? ""));
        return `exit=${r.exitCode}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      },
    },
    {
      spec: {
        name: "read_file",
        description: "Read a text file from the workspace.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      run: (i) => session.readFile(String(i.path ?? "")),
    },
    {
      spec: {
        name: "write_file",
        description: "Create or overwrite a file in the workspace.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      run: async (i) => {
        await session.writeFile(String(i.path ?? ""), String(i.content ?? ""));
        return `wrote ${i.path}`;
      },
    },
    {
      spec: {
        name: "list_files",
        description: "List all files in the workspace (recursive; excludes node_modules/.git).",
        inputSchema: { type: "object", properties: {} },
      },
      run: async () => (await session.listFiles()).join("\n") || "(empty)",
    },
    runCodeTool(session),
  ];
}
