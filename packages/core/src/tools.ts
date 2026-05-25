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
