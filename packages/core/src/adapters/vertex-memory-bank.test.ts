/**
 * Proves the GCP managed memory path (ADR-0044 phase 5) honors the same MemoryAdapter
 * invariants as the files/vector/agentcore adapters — without a network: an injected
 * fetch records the Memory Bank REST calls. Asserts guard-at-the-write-door (a blocked
 * note never reaches the backend), per-tenant `scope`, retrieve→bullet mapping, the
 * eventual-consistency sentinel, and fail-open recall.
 */
import { test, expect } from "bun:test";
import { VertexMemoryBank } from "./vertex-memory-bank";
import type { ContentGuard, GuardVerdict } from "../ports";

// Short-circuit the shared ADC helper (gcp-auth) so authHeaders() doesn't hit the
// real metadata server; the injected fetch handles the Memory Bank calls themselves.
process.env.GCP_ACCESS_TOKEN = "test-token";

const passGuard: ContentGuard = { name: "pass", async screen(text): Promise<GuardVerdict> { return { intervened: false, blocked: false, text }; } };
const blockGuard: ContentGuard = { name: "block", async screen(): Promise<GuardVerdict> { return { intervened: true, blocked: true, text: "" }; } };
const maskGuard: ContentGuard = { name: "mask", async screen(): Promise<GuardVerdict> { return { intervened: true, blocked: false, text: "[redacted]" }; } };

/** A fetch double: records calls and returns a canned body per URL suffix. */
function fakeFetch(handler: (url: string, body: any) => { ok?: boolean; status?: number; json?: any }) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    const r = handler(String(url), body);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function bank(guard: ContentGuard, fetchImpl: typeof fetch) {
  return new VertexMemoryBank("proj", "europe-west2", "eng123", guard, { fetchImpl });
}

test("remember: screens, then POSTs a Memory with fact + tenant scope", async () => {
  const { impl, calls } = fakeFetch(() => ({ json: {} }));
  const [remember] = bank(passGuard, impl).tools("teama");
  const out = await remember.run({ note: "  the   user likes   bun  " });
  expect(out).toBe("remembered: the user likes bun"); // whitespace normalized
  const create = calls.find((c) => c.url.endsWith("/memories"));
  expect(create).toBeDefined();
  expect(create!.body).toEqual({ fact: "the user likes bun", scope: { tenant: "teama" } });
});

test("remember: a guard-blocked note is refused and NEVER hits the backend", async () => {
  const { impl, calls } = fakeFetch(() => ({ json: {} }));
  const [remember] = bank(blockGuard, impl).tools("teama");
  const out = await remember.run({ note: "something toxic" });
  expect(out).toBe("refused: that note was blocked by content safety and was NOT saved");
  expect(calls.length).toBe(0); // no network call at all
});

test("remember: persists the guard-masked text, not the raw note", async () => {
  const { impl, calls } = fakeFetch(() => ({ json: {} }));
  const [remember] = bank(maskGuard, impl).tools("teama");
  const out = await remember.run({ note: "my ssn is 123" });
  expect(out).toBe("remembered: [redacted]");
  expect(calls[0]!.body.fact).toBe("[redacted]");
});

test("memory_search: similarity retrieve within the tenant scope, mapped to bullets", async () => {
  const { impl, calls } = fakeFetch(() => ({
    json: { retrievedMemories: [{ memory: { fact: "likes bun" } }, { memory: { fact: "uses uv" } }] },
  }));
  const [, search] = bank(passGuard, impl).tools("teama");
  const out = await search.run({ query: "tooling prefs" });
  expect(out).toBe("- likes bun\n- uses uv");
  expect(calls[0]!.url).toEndWith("/memories:retrieve");
  expect(calls[0]!.body).toEqual({ scope: { tenant: "teama" }, similaritySearchParams: { searchQuery: "tooling prefs", topK: 8 } });
});

test("memory_search: empty result returns the eventual-consistency sentinel, not an error", async () => {
  const { impl } = fakeFetch(() => ({ json: {} }));
  const [, search] = bank(passGuard, impl).tools("teama");
  const out = await search.run({ query: "anything" });
  expect(out).toContain("no matching memory");
  expect(out).toContain("still be indexing");
});

test("recall: maps facts to bullet lines for prompt injection", async () => {
  const { impl, calls } = fakeFetch(() => ({ json: { retrievedMemories: [{ memory: { fact: "prefers bun" } }] } }));
  const out = await bank(passGuard, impl).recall("teama");
  expect(out).toBe("- prefers bun");
  expect(calls[0]!.body).toEqual({ scope: { tenant: "teama" } }); // simple retrieval
});

test("recall: fail-open — an unreachable backend reads as empty memory, never throws", async () => {
  const { impl } = fakeFetch(() => ({ ok: false, status: 503, json: { error: "down" } }));
  const out = await bank(passGuard, impl).recall("teama");
  expect(out).toBe("");
});

test("tenant scope is sanitized (isolation) and empty note/query are rejected", async () => {
  const { impl, calls } = fakeFetch(() => ({ json: {} }));
  const [remember, search] = bank(passGuard, impl).tools("acme/evil space");
  expect(await remember.run({ note: "   " })).toBe("error: empty note");
  expect(await search.run({ query: "" })).toBe("error: empty query");
  await remember.run({ note: "x" });
  expect(calls[0]!.body.scope).toEqual({ tenant: "acme_evil_space" });
});
