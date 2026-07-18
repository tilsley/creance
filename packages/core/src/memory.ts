/**
 * The `remember` semantic-memory port (ADR-0030). Durable, per-tenant long-term memory surfaced to
 * the agent as tools, plus the MEMORY.md block injected into the system prompt at session start.
 *
 * The STRATEGY is the adapter, not the primitive: `FilesMemory` (keyword search — the cheap/coding
 * default) or `VectorMemory` (Bedrock embeddings — the full-profile semantic recall). Both are
 * files-first: Markdown is the source of truth; a vector store is only an index over the same files.
 * A graph/temporal store (Zep) or a managed layer (Mem0/Letta) would be further adapters here.
 */
import type { AgentTool } from "./tools";

export interface MemoryAdapter {
  readonly name: string;
  /** Long-term memory to inject into the system prompt at session start ("" on the first run).
   *  May be async: file-backed adapters read locally, managed backends (AgentCore Memory,
   *  ADR-0042) fetch over the network — callers must await. */
  recall(tenant: string): string | Promise<string>;
  /** The memory tools (`remember` / `memory_search`) the agent gets alongside its workspace tools. */
  tools(tenant: string): AgentTool[];
}
