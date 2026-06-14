/**
 * FilesMemory — the files-first `remember` adapter (ADR-0030). Durable, per-tenant **semantic** memory
 * as plain Markdown the agent reads and writes: the source of truth is human-readable files, not a
 * vector store (the cheap/coding default — a vector/graph adapter is the scale option behind the same
 * primitive). Memory lives OUTSIDE the ephemeral sandbox — here a durable host directory, in-cluster a
 * mounted per-tenant volume — so it survives across runs.
 *
 *   recall(tenant)      → MEMORY.md, injected into the system prompt at session start (the "loaded
 *                         memory" of openclaw / Claude Code's CLAUDE.md).
 *   tools(tenant)       → `remember` (append a durable note) + `memory_search` (find notes).
 *
 * Retrieval here is keyword/substring (no embeddings — the cheap profile). The full profile swaps in a
 * vector index over the same files (e.g. memsearch's Markdown+Milvus) behind the identical tool surface.
 * Access is append-mostly (ADR-0029/0030): the agent adds and edits its own notes; bulk deletion is the
 * platform's. Per-tenant isolation: one subdirectory per tenant, nothing shared.
 */
import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "../tools";

export class FilesMemory {
  readonly name = "files";
  constructor(private readonly root: string) {}

  private dir(tenant: string): string {
    const d = join(this.root, tenant.replace(/[^a-zA-Z0-9_.@:-]/g, "_")); // per-tenant isolation
    mkdirSync(d, { recursive: true });
    return d;
  }
  private memoryFile(tenant: string): string {
    return join(this.dir(tenant), "MEMORY.md");
  }

  /** Long-term memory to inject into the system prompt at session start (empty on the first run). */
  recall(tenant: string): string {
    const f = this.memoryFile(tenant);
    return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  }

  /** The memory tools the agent gets alongside its workspace tools. */
  tools(tenant: string): AgentTool[] {
    return [
      {
        spec: {
          name: "remember",
          description:
            "Save a durable fact, decision, or preference to your long-term memory (MEMORY.md) for FUTURE sessions. " +
            "Use for things worth keeping across runs — conventions, gotchas, choices, the user's preferences. " +
            "Do NOT use for transient task state.",
          inputSchema: {
            type: "object",
            properties: { note: { type: "string", description: "One concise fact or decision to remember." } },
            required: ["note"],
          },
        },
        run: async (i) => {
          const note = String(i.note ?? "").trim().replace(/\s+/g, " ");
          if (!note) return "error: empty note";
          appendFileSync(this.memoryFile(tenant), `- ${note}\n`);
          return `remembered: ${note}`;
        },
      },
      {
        spec: {
          name: "memory_search",
          description: "Search your long-term memory for relevant notes by keyword. Returns matching lines.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "Words to look for." } },
            required: ["query"],
          },
        },
        run: async (i) => {
          const words = String(i.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
          const text = this.recall(tenant);
          if (!text) return "(memory is empty)";
          const hits = text.split("\n").filter((line) => words.some((w) => line.toLowerCase().includes(w)));
          return hits.length ? hits.join("\n") : "(no matching memory)";
        },
      },
    ];
  }
}
