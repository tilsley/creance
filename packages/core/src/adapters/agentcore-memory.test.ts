/**
 * Proves the managed memory adapter (ADR-0042 phase 2) keeps the port's
 * invariants: writes are guard-screened BEFORE they reach the backend, events
 * land in the tenant's actor/namespace, retrieval maps records to note lines,
 * and an unreachable backend fails open to an empty memory (never a dead run).
 */
import { test, expect } from "bun:test";
import { AgentCoreMemory } from "./agentcore-memory";
import type { ContentGuard } from "../ports";

const passGuard: ContentGuard = { name: "pass", screen: async (text) => ({ blocked: false, text }) } as any;
const blockGuard: ContentGuard = { name: "block", screen: async () => ({ blocked: true, text: "" }) } as any;

function fakeClient(opts: { records?: string[]; fail?: boolean } = {}) {
  const sent: any[] = [];
  return {
    sent,
    client: {
      send: async (cmd: any) => {
        if (opts.fail) throw new Error("backend unreachable");
        sent.push(cmd);
        return { memoryRecordSummaries: (opts.records ?? []).map((t) => ({ content: { text: t } })) };
      },
    } as any,
  };
}

const tool = (m: AgentCoreMemory, name: string) => m.tools("teama").find((t) => t.spec.name === name)!;

test("remember screens the note then writes an event keyed by the tenant", async () => {
  const { client, sent } = fakeClient();
  const m = new AgentCoreMemory("mem-1", passGuard, "eu-west-2", client);
  const out = await tool(m, "remember").run({ note: "  we use  bun " });
  expect(out).toBe("remembered: we use bun");
  const input = sent[0].input;
  expect(input.memoryId).toBe("mem-1");
  expect(input.actorId).toBe("teama");
  expect(input.payload[0].conversational.content.text).toBe("we use bun");
});

test("a guard-blocked note is refused and NEVER reaches the backend", async () => {
  const { client, sent } = fakeClient();
  const m = new AgentCoreMemory("mem-1", blockGuard, "eu-west-2", client);
  const out = await tool(m, "remember").run({ note: "evil" });
  expect(out).toContain("refused");
  expect(sent).toHaveLength(0);
});

test("memory_search retrieves within the tenant namespace and maps records to lines", async () => {
  const { client, sent } = fakeClient({ records: ["we use bun", "budget gate is ours"] });
  const m = new AgentCoreMemory("mem-1", passGuard, "eu-west-2", client);
  const out = await tool(m, "memory_search").run({ query: "runtime tooling" });
  expect(out).toBe("- we use bun\n- budget gate is ours");
  expect(sent[0].input.namespace).toBe("/tenants/teama");
  expect(sent[0].input.searchCriteria.searchQuery).toBe("runtime tooling");
});

test("recall lists recent records; an unreachable backend reads as empty memory", async () => {
  const ok = new AgentCoreMemory("mem-1", passGuard, "eu-west-2", fakeClient({ records: ["a note"] }).client);
  expect(await ok.recall("teama")).toBe("- a note");
  const down = new AgentCoreMemory("mem-1", passGuard, "eu-west-2", fakeClient({ fail: true }).client);
  expect(await down.recall("teama")).toBe("");
});
