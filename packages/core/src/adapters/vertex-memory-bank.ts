/**
 * VertexMemoryBank — the managed `MemoryAdapter` for the GCP profile (ADR-0044 phase 5),
 * the GCP sibling of `AgentCoreMemory`. Durable per-tenant long-term memory on GCP's
 * **Vertex AI Agent Engine Memory Bank**, behind the same port the files/vector adapters
 * honor (ADR-0030): `recall` injects a MEMORY.md-style block into the system prompt;
 * `remember` / `memory_search` are the tools the loop gets alongside its workspace tools.
 *
 * Dependency-free Vertex REST v1beta1 + an ADC token (same stance as the run/spend stores —
 * no google-cloud SDK in the shared image). Memories live under a reasoningEngine parent
 * (`.../reasoningEngines/{id}/memories`) — verified live 2026-07-19: create/retrieve/delete
 * work on any engine with no special config.
 *
 * Per-tenant isolation is Memory Bank's `scope` map, matched EXACTLY on retrieval: we scope
 * every write and read to `{tenant: <sanitized>}`, so tenant A can never retrieve tenant B's
 * memories (probed: a foreign scope returns `{}`). Same sanitisation regex as FilesMemory's
 * per-tenant dir, so tenancy behaves identically across adapters.
 *
 * Guard-at-the-write-door (ADR-0030 §5): a remembered note re-enters future prompts, so
 * writes are content-screened HERE (direction "output") whatever the backend, refused on a
 * block, and only the (possibly masked) text is persisted. `recall` is fail-open — an
 * unreachable backend reads as empty memory, never a dead run. Extraction/indexing is
 * eventually consistent (a fresh note may take a moment to be searchable), so an empty
 * search returns a sentinel, not an error, to stop the model re-saving in a loop.
 */
import type { AgentTool } from "../tools";
import type { MemoryAdapter } from "../memory";
import type { ContentGuard } from "../ports";
import { NoopContentGuard } from "./noop-guard";
import { gcpAccessToken } from "./gcp-auth";

export interface VertexMemoryBankOptions {
  /** Override the aiplatform host (tests / non-default region routing). */
  endpoint?: string;
  /** Injectable fetch for tests; default = global fetch. */
  fetchImpl?: typeof fetch;
}

interface RetrievedMemories {
  retrievedMemories?: Array<{ memory?: { fact?: string } }>;
}

export class VertexMemoryBank implements MemoryAdapter {
  readonly name = "vertex-memory-bank";
  private readonly base: string;
  private readonly fetch: typeof fetch;

  constructor(
    project: string,
    location: string,
    engineId: string,
    private readonly guard: ContentGuard = new NoopContentGuard(),
    opts: VertexMemoryBankOptions = {},
  ) {
    const host = opts.endpoint ?? `https://${location}-aiplatform.googleapis.com`;
    this.base = `${host}/v1beta1/projects/${project}/locations/${location}/reasoningEngines/${engineId}`;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  /** Tenant → the immutable Memory Bank scope. Same sanitisation as FilesMemory's dir. */
  private scope(tenant: string): Record<string, string> {
    return { tenant: tenant.replace(/[^a-zA-Z0-9_.@:-]/g, "_") };
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await gcpAccessToken()}`, "content-type": "application/json" };
  }

  /** POST memories:retrieve with the tenant scope + optional params; return the facts. */
  private async retrieve(tenant: string, params: Record<string, unknown>): Promise<string[]> {
    const res = await this.fetch(`${this.base}/memories:retrieve`, {
      method: "POST",
      headers: await this.authHeaders(),
      body: JSON.stringify({ scope: this.scope(tenant), ...params }),
    });
    if (!res.ok) throw new Error(`Memory Bank retrieve failed ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as RetrievedMemories;
    return (data.retrievedMemories ?? []).map((m) => m.memory?.fact?.trim() ?? "").filter(Boolean);
  }

  async recall(tenant: string): Promise<string> {
    try {
      const facts = await this.retrieve(tenant, {}); // simple retrieval: all memories for the scope
      return facts.map((f) => `- ${f}`).join("\n");
    } catch (e: any) {
      console.error(`vertex memory-bank recall failed (treating as empty): ${e?.message ?? e}`);
      return "";
    }
  }

  tools(tenant: string): AgentTool[] {
    return [
      {
        spec: {
          name: "remember",
          description: "Save a durable fact, decision, or preference to long-term memory for future sessions.",
          inputSchema: {
            type: "object",
            properties: { note: { type: "string", description: "One concise fact or decision to remember." } },
            required: ["note"],
          },
        },
        run: async (i) => {
          const note = String(i.note ?? "").trim().replace(/\s+/g, " ");
          if (!note) return "error: empty note";
          // Guard-screen at the write door: a remembered note re-enters future prompts.
          const v = await this.guard.screen(note, "output");
          if (v.blocked) return "refused: that note was blocked by content safety and was NOT saved";
          try {
            // CreateMemory: the body IS the Memory resource (fact + immutable scope).
            const res = await this.fetch(`${this.base}/memories`, {
              method: "POST",
              headers: await this.authHeaders(),
              body: JSON.stringify({ fact: v.text, scope: this.scope(tenant) }),
            });
            if (!res.ok) return `error: memory not saved (${res.status})`;
          } catch (e: any) {
            return `error: memory backend unavailable: ${e?.message ?? e}`;
          }
          return `remembered: ${v.text}`;
        },
      },
      {
        spec: {
          name: "memory_search",
          description: "Search your long-term memory by meaning to recall past facts/decisions. Args: query.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "What you want to recall." } },
            required: ["query"],
          },
        },
        run: async (i) => {
          const query = String(i.query ?? "").trim();
          if (!query) return "error: empty query";
          let hits: string[];
          try {
            hits = await this.retrieve(tenant, { similaritySearchParams: { searchQuery: query, topK: 8 } });
          } catch (e: any) {
            return `error: memory backend unavailable: ${e?.message ?? e}`;
          }
          return hits.length
            ? hits.map((t) => `- ${t}`).join("\n")
            : "(no matching memory — notes saved in the last few minutes may still be indexing; a successful `remember` does NOT need re-saving or verification)";
        },
      },
    ];
  }
}
