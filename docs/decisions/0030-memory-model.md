# ADR-0030: Memory model — `remember` as a primitive behind a port; files-first and vector/graph as reference adapters

- **Status:** Accepted
- **Date:** 2026-06-14

## Context

`remember` is one of the three L0 primitives ([primitives.md](../primitives.md)), and its *backends*
are decided ([0023](0023-memory-backends-postgres-redis.md): Postgres system-of-record + pgvector +
Redis hot tier). What is **not** decided is the *memory model* — the tiers, what gets written, how it
is retrieved, how it is scoped/governed, and (the question that started this) whether memory is a
**vector store** the agent queries or **files** the agent reads and writes. [0029](0029-governed-egress-choke-points.md)
deliberately left one piece open: the `remember` access policy (append-mostly vs agent-deletable).

A tempting answer — "files-first markdown, like openclaw/Claude-Code" — is the *wrong shape* for a
**general** platform. agent-os runs coding agents *and* support bots *and* assistants; files-first is
best-evidenced for coding, vector/graph for enterprise recall. Baking one strategy into the primitive
would repeat the mistake [0003](0003-ports-and-adapters.md) exists to prevent. So this ADR settles the
*model and the seam*, not the strategy, and maps strategies to use cases as **adapters**.

## Landscape — agent memory in 2026 (researched 2026-06-14)

Four schools, converging on a layered combination, not one winner:

| School | Reference | Idea | Strength / weakness |
|---|---|---|---|
| **Vector store** | **Mem0** | flat embeddings, semantic recall | quickest to persistent memory; weak on multi-hop/temporal (≈49% LongMemEval) |
| **Temporal graph** | **Zep / Graphiti** | facts with validity windows (`true from X until Y`) | best temporal reasoning (≈64%); heavier |
| **Tiered / self-editing** | **Letta (MemGPT)** | OS model: core (in-context RAM) + recall (cache) + archival (disk/vector); agent edits its own memory | strong for long-horizon; agent-managed |
| **Files-first** | **openclaw · `zilliztech/memsearch` · Context Trees** | markdown is the source of truth; a vector store is an **index over the files** | transparent, git-versionable, great for code; scale/context-budget ceiling |

Three findings shaped the decision:

- **"Retrieval > storage."** Every framework can *store*; the differentiator is *how memory is found
  and re-injected*. Recall quality (hybrid vector+keyword, recency/importance/relevance weighting — the
  Generative-Agents triad) is the hard part, not the backend.
- **Structural search beats vector-RAG *as the default* for code** (refined 2026-06-24 — see the update
  section; the original "vector RAG *fails* for code" overreaches). Similarity search returns isolated
  snippets and "misses the forest for the trees" — fetches functions, loses architecture — so
  agentic/structural search (grep/AST/repo-map) is the default and files-first is better-evidenced
  *there*; vectors remain an additive, keyword-central hybrid layer, not the primary signal.
- **The curation problem.** "Building a vector retrieval layer before you understand access patterns is
  building the wrong thing fast." Markdown-first lets you learn the access patterns before optimizing —
  which is *why* the sequencing is build-the-agent-then-design-memory, not the reverse.
- **The convergence is layered.** In-context (working) + structured files (exact) + vector index
  (semantic retrieval). `memsearch` (markdown **and** Milvus, for Claude Code/Codex) is the existence
  proof of the files-as-truth / vector-as-index synthesis.

## Decision

**`remember` is a primitive behind a port. The platform ships the seam, the tier model, and the
governance; the *strategy* (files-first / vector / graph / tiered) is an adapter chosen per use case
and deployment profile.** No single memory model is privileged.

**1. Tiers (general, all adapters).** Three distinct memories, only one of which is the gap:
- **Working** — within-run scratchpad → the **sandbox session** ([0020](0020-sandbox-execution-model.md)). Built.
- **Episodic** — what happened in past runs → the **RunStore** ([0023](0023-memory-backends-postgres-redis.md)). Built; needs *surfacing back* to the agent.
- **Semantic** — durable cross-run knowledge (facts, decisions, preferences, codebase shape) → the **adapter**. The unbuilt piece.

**2. The port abstracts a capability, not a storage shape.** `remember` = *durable, scoped, retrievable
memory surfaced to the agent as tools*. The adapter chooses the **tool surface**, because the two
families interact differently and one typed `store/get` interface would exclude files-first:
- **Files-first adapter** — a durable per-tenant memory dir mounted into the sandbox workspace + a
  `memory_search` tool (a vector index over the files). The agent uses ordinary file tools
  (read/write/edit) + search; memory is "just files" (transparent, git-versionable).
- **Vector/graph adapter** — typed `store(fact)` / `retrieve(query)` tools (own pgvector, or **Mem0 /
  Zep / Letta** behind the port). The agent calls the API.

The **common contract** both must honour: durability across runs, **per-tenant scope + isolation**,
retrieval as a first-class operation, and the tier model above.

**3. Use case → default adapter** (the generality — both excel):
- **Coding agents** → files-first + structural/agentic search (the code default; vectors additive — see the 2026-06-24 update); transparency; git; sandbox-governed.
- **Support bots / enterprise recall** → vector (Mem0) or temporal graph (Zep) over the knowledge base.
- **Long-horizon assistants** → tiered self-editing (Letta-style core/recall/archival).

**4. Durable backing vs the ephemeral workspace.** Files-first's seam: the sandbox is ephemeral, so the
memory dir must be **durably backed per tenant** — loaded into the workspace at session start, synced
back at end, indexed for search. This is where [0023](0023-memory-backends-postgres-redis.md)'s
Postgres/pgvector **returns, repositioned**: the durable store + retrieval index *behind* the files, not
the agent's interface.

**5. Governance (strategy-independent — the platform-level part).**
- **Per-tenant isolation** is mandatory in every adapter (tenant A can never retrieve B's memory).
- **No memory gateway** ([0029](0029-governed-egress-choke-points.md)): governance lives at the
  port/adapter. For files-first this is *strongest* — memory is workspace files, **sandbox-governed**;
  the agent can't reach another tenant's because it isn't in its workspace.
- **Access policy (settles 0029's open question): append-mostly.** The agent appends and edits *its own*
  memory; bulk/destructive deletion is reserved to the platform (retention/GC). The files-first adapter
  gets audit + rollback for free via **git**; the vector adapter logs writes (`record`).
- **Memory is a prompt-injection surface.** An agent that ingests poisoned content and writes it to
  memory re-injects it next session. Writes are screened by **guard** ([0008](0008-guard-content-safety-primitive.md))
  on the way in, same as any untrusted ingress; consolidation (below) is a second filter.

**6. Retrieval + consolidation are first-class.** The port exposes retrieval (not just store/get); the
adapter owns recall quality (hybrid search, recency/importance/relevance). An optional **consolidation
pass** ("dreaming"/reflection) promotes/summarises high-signal memory and bounds growth — recognised
across the field (openclaw's gates, Generative-Agents reflection).

**7. Profile default** (mirrors [0027](0027-two-deployment-profiles.md)): **cheap profile → files-first**
(no vector infra, scale-to-zero, transparent); **full profile → vector/graph** (pgvector / Mem0 / Zep)
for scale + temporal. Same `remember` contract across both, like every other capability.

## Implementation (built 2026-06-14)

Both **reference adapters** of the port exist and are validated end-to-end:

- **`MemoryAdapter` port** (`packages/core/src/memory.ts`) — `recall(tenant)` (the MEMORY.md block
  injected at session start) + `tools(tenant)` (`remember` / `memory_search`). The *strategy is the
  adapter*, not the primitive.
- **Files-first / cheap profile** (`FilesMemory`) — Markdown is the source of truth; keyword search with
  honest stopword removal. Per-tenant subdirectory isolation.
- **Full profile** (`VectorMemory`) — same files-first Markdown, but `memory_search` is **semantic**
  (Amazon Titan Text Embeddings v2 via Bedrock, keyless). A `.index.json` sidecar is brute-forced
  in-process (correct + instant at files-first scale; **pgvector is the at-scale swap behind the same
  adapter**, [0023](0023-memory-backends-postgres-redis.md)) and **self-heals** from MEMORY.md, so human
  edits to the file are picked up.
- **Access policy is enforced, not just stated** — `remember` **writes are guard-screened**
  ([0008](0008-guard-content-safety-primitive.md)): a blocked note is refused (never persisted, not to
  Markdown nor the index); a masked note is stored masked. A remembered note re-enters future sessions,
  so the gate is at the write door.
- **Proven live** (`examples/coding-agent-memory`, Bedrock eu-west-2): memory **persists across a fresh
  session** through the governed gateway, and the **semantic edge** is isolated at the tool level — a
  no-shared-keyword query that keyword search misses, vector recalls by meaning.

**Not yet built (deliberate, decided):** pgvector at scale; graph/temporal (Zep) and managed (Mem0/Letta)
adapters; the consolidation/reflection pass. All swappable behind this same port.

## Update — production-agent evidence + the hybrid refinement (researched 2026-06-24)

A deeper research pass (20 sources, claims adversarially verified by 3-vote panels) **validated the
core of this ADR and corrected one overreach.** Net: there is an *emerging, not unanimous* consensus
that coding agents want **structural/agentic search as the default**, with vectors as an **additive
hybrid** complement — the honest position is *hybrid*, **not "vectors are dead."**

**Validated (high confidence, primary sources):**
- **Production agents abandoned vector-RAG for code as the default.** Claude Code's creator (Boris
  Cherny, Anthropic, on the record) confirms early versions used "RAG + a local vector db" but "agentic
  search generally works better" — an engineer added it **"outperformed [it] by a lot, and this was
  surprising."** Its surface is glob + grep (ripgrep) + Read + an Explore sub-agent. **Aider** ranks
  context via tree-sitter **ASTs + a dependency graph** (PageRank-style), not embeddings.
- **"Retrieval > storage" is benchmark-confirmed.** SWE-Explore (arXiv:2606.07297, Jun 2026): agentic
  explorers reach ~0.65 file-recall vs BM25 0.079 / dense 0.088 / random 0.004 (classical retrieval
  near random) — **and** the limiting term is **line-level localization recall** (~0.14–0.19). Precise
  *selection*, not storage, is the hard part — exactly this ADR's claim.

**Refined (the overreach):** "Vector RAG *fails* for code" is too absolute. The defensible claim is
**structural/agentic search is the *default* for code; vectors are an *additive* hybrid complement,
keyword/BM25-central (exact-match for symbols + IDs).** Anthropic's **Contextual Retrieval** (Sept
2024): contextual embeddings cut retrieval failure 5.7%→3.7%, **+contextual BM25 → 2.9%**, rerank →
1.9% (BM25 central, embeddings additive); **Cursor** still runs embeddings (Turbopuffer) and reports a
**~12.5% accuracy gain** from semantic search "where grep alone falls short." Over-broad claims were
*refuted* (3-vote): "1M context makes vectors unnecessary" (0-3), "all production agents reject vectors"
(0-3), "Cody pre-indexes with vectors" (0-3) — so avoid absolutism in *either* direction.

**OpenClaw, corrected:** it is **files-first in *storage*** (3-tier Markdown, "no hidden state") **but
*hybrid* in retrieval** — `memory_search` combines vector similarity with **keyword matching for exact
terms like IDs and code symbols.** So it's the existence proof of this ADR's *files-as-truth +
index-over-files* synthesis — **not** a pure-grep system. It closely mirrors our own `FilesMemory` +
optional `VectorMemory`.

**What this changes for us (actionable):**
- **The next memory lever for *coding* is a repo-map / AST / grep tool surface (Aider-style), NOT a
  better embedding store.** `FilesMemory`'s keyword default is the right base; the high-value add is
  **structural navigation over the files**, with semantic as the additive layer.
- **When the vector adapter is built, make it keyword/BM25-*central* + embeddings *additive*** (the
  Contextual-Retrieval / OpenClaw pattern), with exact-match for code symbols/IDs — not embeddings-first.
- **Do *not* invest in a managed memory layer (Mem0/Zep) for the *coding* default.** Those target
  conversational/personalization recall; **no code-specific evidence** surfaced, and their headline
  benchmarks are inflated (Mem0 self-reported 91.6% LoCoMo vs ~58–66% independent reproduction).
- **pgvector suffices** as the at-scale backing ([0023](0023-memory-backends-postgres-redis.md)) — the
  default for the great majority of agent workloads; a specialized vector DB is only warranted at
  extreme scale (>10M+ vectors / sub-10ms p99).

**Caveats:** fast-moving field; the primary anchors (Aider docs, Anthropic Contextual Retrieval,
Cursor's blogs, the SWE-Explore paper, Cherny on record) are solid, but several supporting points lean
on secondary blogs; Claude Code's "autoDream" memory-consolidation subagent appears in *extracted
system prompts* but is likely **staged/unreleased** (not GA — don't cite as shipped).

## Consequences

- **+** Stays **general**: support bots get vector/graph recall, coding agents get files-first, both
  behind one port — the platform mechanism, not a bet on one school.
- **+** Files-first as the cheap/coding default is **transparent and git-versionable** (you can read what
  your agent believes), and reuses the sandbox — no new "memory plane".
- **+** Settles the [0029](0029-governed-egress-choke-points.md) access-policy question (append-mostly +
  platform-side GC) and reaffirms *no memory gateway* (sandbox-governed for files; port-governed for the API).
- **+** Repositions [0023](0023-memory-backends-postgres-redis.md) cleanly — Postgres/pgvector as durable
  backing + index, not the agent's interface — without discarding it.
- **−** **Two tool surfaces** (file-tools+search vs store/retrieve) means the runtime must wire memory
  tools per adapter — more than a single typed call. The cost of staying general.
- **−** **Retrieval quality is the hard, unsolved part** and is per-adapter; a bad recall strategy makes
  memory useless regardless of backend. The ADR names it; it doesn't solve it.
- **−** Files-first has a **scale/context-budget ceiling**; at large memory volumes the vector/graph
  adapter (or consolidation) is required — a real switch, not free.

## Relationship

Realises the `remember` primitive ([primitives.md](../primitives.md)) behind the port discipline of
[0003](0003-ports-and-adapters.md); **repositions** [0023](0023-memory-backends-postgres-redis.md)
(Postgres/pgvector → durable backing + index, not interface); **settles** [0029](0029-governed-egress-choke-points.md)'s
access-policy open question (append-mostly, no gateway) and inherits its "memory is not a gateway,
governed at the port" finding; the files-first adapter lives in the sandbox ([0020](0020-sandbox-execution-model.md))
and is screened by guard ([0008](0008-guard-content-safety-primitive.md)); the profile default mirrors
[0027](0027-two-deployment-profiles.md). One-liner: **memory is a primitive behind a port, not a chosen
storage shape — three tiers (working/episodic/semantic), per-tenant-isolated and append-mostly, with
files-first (transparent, sandbox-governed, the coding/cheap default) and vector/graph (Mem0/Zep, the
recall/scale default) as co-equal adapters; retrieval, not storage, is the hard part.**

## Sources

- Frameworks: [Mem0 vs Zep vs Letta vs Cognee — practical guide](https://dev.to/agdex_ai/ai-agent-memory-in-2026-mem0-vs-zep-vs-letta-vs-cognee-a-practical-guide-cfa) · [5 memory systems compared](https://medium.com/@wasowski.jarek/i-compared-5-ai-agent-memory-systems-across-6-dimensions-none-wins-6a658335ed0a) · [Best memory frameworks 2026](https://atlan.com/know/best-ai-agent-memory-frameworks-2026/)
- Files-first: [openclaw memory concepts](https://docs.openclaw.ai/concepts/memory) · [`zilliztech/memsearch` (Markdown + Milvus)](https://github.com/zilliztech/memsearch) · [Markdown-first multi-agent memory](https://dev.to/whoffagents/multi-agent-memory-without-a-vector-database-the-markdown-first-approach-2lo0)
- Retrieval / code: [Why Vector RAG Fails for Code](https://www.byterover.dev/blog/why-vector-rag-fails-for-code-we-tested-it-on-1-300-files) · [Vector vs Graph vs Episodic memory](https://www.digitalapplied.com/blog/agent-memory-architectures-vector-graph-episodic)
- 2026-06-24 pass (production agents + benchmarks): [Claude Code abandoned indexing for grep](https://vadim.blog/claude-code-no-indexing/) (Cherny on record) · [Aider repo-map (tree-sitter AST + dependency graph)](https://aider.chat/2023/10/22/repomap.html) · [SWE-Explore benchmark, arXiv:2606.07297](https://arxiv.org/html/2606.07297v1) (agentic ≫ classical retrieval; line-recall is the bottleneck) · [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) (BM25 central, embeddings additive) · [Cursor semantic search](https://cursor.com/blog/semsearch) (hybrid; ~12.5% gain) · [Cursor fast regex search](https://cursor.com/blog/fast-regex-search) (freshness; sparse n-gram index) · [OpenClaw memory](https://docs.openclaw.ai/concepts/memory/) (files-first storage + hybrid retrieval)
