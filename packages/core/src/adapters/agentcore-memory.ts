/**
 * AgentCoreMemory — the managed `remember` adapter (ADR-0042 phase 2), filling the
 * managed-adapter seat ADR-0030 reserved. One more strategy behind the same port —
 * files-first stays the coding/cheap default; this exists to feel out the managed
 * backend and its one genuinely differentiating feature: per-tenant namespaces
 * (`/tenants/{actorId}`) enforceable by IAM condition keys, isolation by IAM
 * rather than by adapter code.
 *
 *   remember       → CreateEvent (short-term event; the SEMANTIC strategy extracts
 *                    long-term records into the tenant's namespace ASYNCHRONOUSLY —
 *                    a note may take a minute to become searchable, unlike files)
 *   memory_search  → RetrieveMemoryRecords (semantic search within the namespace)
 *   recall(tenant) → ListMemoryRecords (recent records, injected at session start)
 *
 * Guard-at-the-write-door is unchanged (ADR-0030 §5): a remembered note re-enters
 * future prompts, so writes are screened HERE, whatever the backend.
 */
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { AgentTool } from "../tools";
import type { MemoryAdapter } from "../memory";
import type { ContentGuard } from "../ports";
import { NoopContentGuard } from "./noop-guard";

export class AgentCoreMemory implements MemoryAdapter {
  readonly name = "agentcore";
  private readonly client: BedrockAgentCoreClient;
  /** One event session per process — events are keyed (actor, session); extraction
   *  into the tenant namespace doesn't depend on the session id. */
  private readonly sessionId = crypto.randomUUID();

  constructor(
    private readonly memoryId: string,
    private readonly guard: ContentGuard = new NoopContentGuard(),
    region?: string,
    client?: BedrockAgentCoreClient, // injectable for tests
  ) {
    this.client = client ?? new BedrockAgentCoreClient({ region: region ?? process.env.REGION ?? "eu-west-2" });
  }

  /** Tenant → namespace. Same sanitisation as FilesMemory's per-tenant dir. */
  private namespace(tenant: string): string {
    return `/tenants/${tenant.replace(/[^a-zA-Z0-9_.@:-]/g, "_")}`;
  }

  private recordText(r: { content?: { text?: string } }): string {
    return r.content?.text?.trim() ?? "";
  }

  /** Recent long-term records, injected at session start. Fail-open to "" — an
   *  unreachable memory backend reads as an empty memory, not a dead run. */
  async recall(tenant: string): Promise<string> {
    try {
      const out = await this.client.send(
        new ListMemoryRecordsCommand({ memoryId: this.memoryId, namespace: this.namespace(tenant), maxResults: 20 }),
      );
      return (out.memoryRecordSummaries ?? [])
        .map((r) => this.recordText(r))
        .filter(Boolean)
        .map((t) => `- ${t}`)
        .join("\n");
    } catch (e: any) {
      console.error(`agentcore memory recall failed (treating as empty): ${e?.message ?? e}`);
      return "";
    }
  }

  tools(tenant: string): AgentTool[] {
    return [
      {
        spec: {
          name: "remember",
          description:
            "Save a durable fact, decision, or preference to your long-term memory for FUTURE sessions. " +
            "Use for things worth keeping across runs — conventions, gotchas, choices, the user's preferences. " +
            "Do NOT use for transient task state. (Managed backend: the note becomes searchable after a short delay.)",
          inputSchema: {
            type: "object",
            properties: { note: { type: "string", description: "One concise fact or decision to remember." } },
            required: ["note"],
          },
        },
        run: async (i) => {
          const note = String(i.note ?? "").trim().replace(/\s+/g, " ");
          if (!note) return "error: empty note";
          const v = await this.guard.screen(note, "output");
          if (v.blocked) return "refused: that note was blocked by content safety and was NOT saved";
          // role USER, deliberately: the semantic strategy mines *user* turns for
          // facts — an ASSISTANT-only event yielded no extracted records in the
          // live smoke. A remembered note is knowledge told TO the agent anyway.
          await this.client.send(
            new CreateEventCommand({
              memoryId: this.memoryId,
              actorId: tenant,
              sessionId: this.sessionId,
              eventTimestamp: new Date(),
              payload: [{ conversational: { role: "USER", content: { text: v.text } } }],
            }),
          );
          return `remembered: ${v.text}`;
        },
      },
      {
        spec: {
          name: "memory_search",
          description: "Search your long-term memory for relevant notes. Semantic — matches meaning, not just keywords.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "What you want to recall." } },
            required: ["query"],
          },
        },
        run: async (i) => {
          const query = String(i.query ?? "").trim();
          if (!query) return "error: empty query";
          const out = await this.client.send(
            new RetrieveMemoryRecordsCommand({
              memoryId: this.memoryId,
              namespace: this.namespace(tenant),
              searchCriteria: { searchQuery: query, topK: 8 },
            }),
          );
          const hits = (out.memoryRecordSummaries ?? []).map((r) => this.recordText(r)).filter(Boolean);
          return hits.length ? hits.map((t) => `- ${t}`).join("\n") : "(no matching memory)";
        },
      },
    ];
  }
}
