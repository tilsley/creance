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
