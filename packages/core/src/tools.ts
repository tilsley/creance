/**
 * Agent tools — the things the model can call. A tool is a JSON-schema spec +
 * a handler. `workspaceTools` exposes the Sandbox workspace (run/read/write/list)
 * to the model, which is what lets an agent investigate and edit a repo.
 */
import type { SandboxSession, ToolDef } from "./ports";

export interface AgentTool {
  spec: ToolDef;
  run(input: Record<string, unknown>): Promise<string>;
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
