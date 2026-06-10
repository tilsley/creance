/**
 * One governed OpenCode session — the `think+do` of the doc-gardener.
 *
 * The OpenCode SDK spawns a local opencode server (the engine: agent loop, file tools),
 * configured so its ONLY model route is our inference gateway on the Anthropic wire
 * (@ai-sdk/anthropic with a custom baseURL → LiteLLM /v1/messages). Identity rides the
 * same two modes as every agent on the platform:
 *   cheap mode — AGENT_TOKEN(_FILE) forwarded as the api key (gateway verifies vs JWKS)
 *   full mode  — no token at all; the mesh (Linkerd) stamps l5d-client-id
 * Either way the agent process holds no model credentials, and the gateway meters every
 * think against the tenant's claim.
 *
 * Tools are restricted at the session: file read/edit only — no bash, no webfetch, no
 * subagents. The write allowlist (allowlist.ts) is still enforced after the session;
 * tool restriction bounds behaviour, the allowlist bounds the damage.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";

export interface SessionResult {
  text: string;
  toolCalls: { tool: string; title?: string }[];
  tokens: { input: number; output: number };
  costUsd: number;
}

const DENIED_TOOLS = { bash: false, webfetch: false, websearch: false, task: false, patch: false } as const;

export async function runDocSession(workspace: string, prompt: string): Promise<SessionResult> {
  const gatewayUrl = (process.env.INFERENCE_GATEWAY_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const model = process.env.MODEL_ID ?? "claude-haiku";
  const token =
    process.env.AGENT_TOKEN ??
    (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, "utf8").trim() : "mesh-identity");

  // The SDK spawns `opencode` from PATH and the server keeps state under the XDG dirs.
  // Pin BOTH: our lockfile's binary (not whatever is installed globally — client/server
  // version skew corrupts nothing but fails weirdly), and a throwaway data home (a shared
  // ~/.local/share/opencode database from another version breaks the server's migrations).
  process.env.PATH = `${join(import.meta.dir, "node_modules", ".bin")}:${process.env.PATH}`;
  const scratch = mkdtempSync(join(tmpdir(), "doc-gardener-oc-"));
  for (const dir of ["DATA", "CONFIG", "CACHE", "STATE"]) {
    process.env[`XDG_${dir}_HOME`] = join(scratch, dir.toLowerCase());
  }

  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 30_000,
    config: {
      autoupdate: false,
      provider: {
        gateway: {
          npm: "@ai-sdk/anthropic", // the anthropic wire: native tool_use deltas, max_tokens always set
          name: "agent-os inference gateway",
          options: { baseURL: `${gatewayUrl}/v1`, apiKey: token, timeout: 600_000 },
          models: { [model]: { name: model, limit: { context: 200_000, output: 4_096 } } },
        },
      },
      model: `gateway/${model}`,
      // deny up front so a headless run can never block on an "ask"
      permission: { edit: "allow", bash: { "*": "deny" }, webfetch: "deny" },
    },
  });

  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const session = await client.session.create({
      body: { title: "doc-gardener run" },
      query: { directory: workspace },
      throwOnError: true,
    });

    const result = await client.session.prompt({
      path: { id: session.data.id },
      query: { directory: workspace },
      body: {
        model: { providerID: "gateway", modelID: model },
        tools: { ...DENIED_TOOLS },
        parts: [{ type: "text", text: prompt }],
      },
      throwOnError: true,
    });

    // the prompt result is only the FINAL assistant message — tool calls and per-turn
    // token spend live on the earlier messages, so aggregate over the whole session
    const messages = await client.session.messages({
      path: { id: session.data.id },
      query: { directory: workspace },
      throwOnError: true,
    });

    const toolCalls: SessionResult["toolCalls"] = [];
    const tokens = { input: 0, output: 0 };
    let costUsd = 0;
    for (const m of messages.data) {
      if (m.info.role !== "assistant") continue;
      // count cached prompt tokens as input — they are real context (and real, cheaper, spend)
      tokens.input += (m.info.tokens?.input ?? 0) + (m.info.tokens?.cache?.read ?? 0) + (m.info.tokens?.cache?.write ?? 0);
      tokens.output += m.info.tokens?.output ?? 0;
      costUsd += m.info.cost ?? 0;
      for (const p of m.parts) {
        if (p.type === "tool") toolCalls.push({ tool: p.tool ?? "?", title: (p as { state?: { title?: string } }).state?.title });
      }
    }

    return {
      text: (result.data.parts ?? [])
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("\n"),
      toolCalls,
      tokens,
      costUsd,
    };
  } finally {
    server.close();
  }
}
