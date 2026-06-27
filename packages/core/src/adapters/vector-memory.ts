/**
 * VectorMemory — the full-profile `remember` adapter (ADR-0030/0027). Files-first like FilesMemory
 * (Markdown MEMORY.md is the source of truth, injected into the system prompt), but `memory_search`
 * is **hybrid** — keyword-central + semantic-additive (the 2026-06-24 research refinement). Each note
 * is embedded (Bedrock Titan) and scored by cosine similarity, AND an exact query-term match (a code
 * symbol / ID / error code) BOOSTS the note. So "how do I run the unit suite?" still finds "the test
 * command is bun test" by meaning (no shared keyword — what FilesMemory misses), while an exact query
 * like "ORD-42" or "TenantInferenceProfile" hits its note precisely rather than being lost to fuzzy
 * similarity. Pure-semantic loses exact-match for symbols; hybrid keeps both (cf. OpenClaw, Anthropic
 * Contextual Retrieval — BM25/keyword central, embeddings additive).
 *
 * The vector store here is a JSON sidecar (`.index.json`) brute-forced in process — correct + instant
 * at files-first scale (hundreds of notes). At larger scale the same cosine moves to pgvector
 * (ADR-0023) behind this identical adapter; the Markdown stays the truth either way. The index
 * self-heals from MEMORY.md, so a human editing the Markdown is picked up on the next search.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "../tools";
import type { ContentGuard } from "../ports";
import { NoopContentGuard } from "./noop-guard";
import { FilesMemory } from "./files-memory";
import { BedrockEmbeddings } from "./bedrock-embeddings";

interface IndexEntry {
  note: string;
  embedding: number[];
}

export class VectorMemory extends FilesMemory {
  readonly name = "vector";
  constructor(
    root: string,
    private readonly embeddings = new BedrockEmbeddings(),
    guard: ContentGuard = new NoopContentGuard(),
  ) {
    super(root, guard);
  }

  private indexFile(tenant: string): string {
    return join(this.dir(tenant), ".index.json");
  }
  private readIndex(tenant: string): IndexEntry[] {
    const f = this.indexFile(tenant);
    if (!existsSync(f)) return [];
    try {
      return JSON.parse(readFileSync(f, "utf8")) as IndexEntry[];
    } catch {
      return [];
    }
  }
  private writeIndex(tenant: string, idx: IndexEntry[]): void {
    writeFileSync(this.indexFile(tenant), JSON.stringify(idx));
  }

  /** the notes in MEMORY.md (the source of truth) — `- ...` lines. */
  private notes(tenant: string): string[] {
    return this.recall(tenant)
      .split("\n")
      .map((l) => l.replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
  }

  /** sync the index with MEMORY.md — embed any notes not yet indexed (incl. human edits to the file). */
  private async ensureIndex(tenant: string): Promise<IndexEntry[]> {
    const idx = this.readIndex(tenant);
    const have = new Set(idx.map((e) => e.note));
    let changed = false;
    for (const note of this.notes(tenant)) {
      if (!have.has(note)) {
        idx.push({ note, embedding: await this.embeddings.embed(note) });
        changed = true;
      }
    }
    if (changed) this.writeIndex(tenant, idx);
    return idx;
  }

  tools(tenant: string): AgentTool[] {
    return [
      {
        spec: {
          name: "remember",
          description:
            "Save a durable fact, decision, or preference to long-term memory for FUTURE sessions. " +
            "Use for conventions, gotchas, choices, the user's preferences — not transient task state.",
          inputSchema: {
            type: "object",
            properties: { note: { type: "string", description: "One concise fact or decision to remember." } },
            required: ["note"],
          },
        },
        run: async (i) => {
          const note = String(i.note ?? "").trim().replace(/\s+/g, " ");
          if (!note) return "error: empty note";
          const safe = await this.screenWrite(note); // same gate as files-first, before it's indexed
          if (safe === null) return "refused: that note was blocked by content safety and was NOT saved";
          appendFileSync(this.memoryFile(tenant), `- ${safe}\n`); // Markdown = source of truth
          const idx = this.readIndex(tenant);
          idx.push({ note: safe, embedding: await this.embeddings.embed(safe) }); // vector index over it
          this.writeIndex(tenant, idx);
          return `remembered: ${safe}`;
        },
      },
      {
        spec: {
          name: "memory_search",
          description:
            "Search your long-term memory by MEANING (semantic) AND exact keywords (hybrid). Finds " +
            "relevant notes even when the wording differs, and matches exact terms like IDs, code " +
            "symbols, or error codes precisely.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "What you want to recall." } },
            required: ["query"],
          },
        },
        run: async (i) => {
          const q = String(i.query ?? "").trim();
          if (!q) return "error: empty query";
          const idx = await this.ensureIndex(tenant);
          if (!idx.length) return "(memory is empty)";
          const qe = await this.embeddings.embed(q);
          const terms = this.queryTerms(q);
          // HYBRID (ADR-0030 research refinement): keyword-central + semantic-additive. Each exact
          // query-term match (a code symbol / ID / error code) adds KW_BOOST on top of the semantic
          // cosine — so precise recall isn't lost to fuzzy meaning, while semantic still surfaces
          // notes that share NO keyword with the query (the edge pure-keyword can't reach).
          const KW_BOOST = 0.5;
          const ranked = idx
            .map((e) => {
              const lower = e.note.toLowerCase();
              const kw = terms.filter((t) => lower.includes(t)).length;
              return { note: e.note, score: cosine(qe, e.embedding) + KW_BOOST * kw };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
          return ranked.map((r) => `(${r.score.toFixed(2)}) ${r.note}`).join("\n");
        },
      },
    ];
  }
}

/** cosine similarity (Titan returns unit vectors, but be robust to non-normalized inputs). */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
