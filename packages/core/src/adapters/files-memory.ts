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
import type { MemoryAdapter } from "../memory";
import type { ContentGuard } from "../ports";
import { NoopContentGuard } from "./noop-guard";

// prettier-ignore
const STOPWORDS = new Set("a an and are as at be but by do does for from how i in into is it of on or our that the this to was what when where which who will with you your".split(" "));

export class FilesMemory implements MemoryAdapter {
  readonly name = "files";
  constructor(
    protected readonly root: string,
    // A remembered note is re-injected into FUTURE sessions' system prompts, so unsafe content
    // persisted here would re-enter the agent across runs. Screen writes at the door (ADR-0030
    // access-policy / ADR-0008 guard). Defaults to no-op so the demo runs without a guardrail.
    protected readonly guard: ContentGuard = new NoopContentGuard(),
  ) {}

  /** Screen a note before it is persisted. Returns the (possibly masked) text to store, or `null`
   *  if the guard blocked it outright — the note must NOT be written. Direction is "output": the
   *  agent is emitting content into the durable store (it becomes ingress when re-injected later). */
  protected async screenWrite(note: string): Promise<string | null> {
    const v = await this.guard.screen(note, "output");
    return v.blocked ? null : v.text;
  }

  /** per-tenant directory (isolation); `protected` so VectorMemory can index the same files. */
  protected dir(tenant: string): string {
    const d = join(this.root, tenant.replace(/[^a-zA-Z0-9_.@:-]/g, "_"));
    mkdirSync(d, { recursive: true });
    return d;
  }
  protected memoryFile(tenant: string): string {
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
          const safe = await this.screenWrite(note);
          if (safe === null) return "refused: that note was blocked by content safety and was NOT saved";
          appendFileSync(this.memoryFile(tenant), `- ${safe}\n`);
          return `remembered: ${safe}`;
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
          // keyword search, with stopword removal so the baseline is honest (not a strawman that
          // false-matches on "the"/"is"). Its limit — and why the vector adapter exists — is that it
          // can't match meaning: a query sharing no keywords with the note returns nothing.
          const words = String(i.query ?? "")
            .toLowerCase()
            .split(/\s+/)
            .map((w) => w.replace(/[^a-z0-9]/g, ""))
            .filter((w) => w.length > 1 && !STOPWORDS.has(w));
          const text = this.recall(tenant);
          if (!text) return "(memory is empty)";
          const hits = text.split("\n").filter((line) => words.some((w) => line.toLowerCase().includes(w)));
          return hits.length ? hits.join("\n") : "(no matching memory)";
        },
      },
    ];
  }
}
