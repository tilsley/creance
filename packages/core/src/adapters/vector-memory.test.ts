/**
 * VectorMemory logic — deterministic, no Bedrock (a fake embedder injected). Asserts the index ranks
 * the semantically-closest note first, that Markdown stays the source of truth, and that the index
 * self-heals from MEMORY.md (a human edit is picked up on the next search).
 */
import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorMemory } from "./vector-memory";

// a toy 3-dim embedder: [test-ish, deploy-ish, auth-ish] — enough to exercise cosine ranking.
const fakeEmbeddings = {
  name: "fake",
  model: "fake",
  async embed(t: string): Promise<number[]> {
    const s = t.toLowerCase();
    const has = (...ws: string[]) => (ws.some((w) => s.includes(w)) ? 1 : 0);
    return [has("test", "verify", "check", "run"), has("deploy", "ship", "release"), has("auth", "key", "cred")];
  },
};

const vm = (dir: string) => new VectorMemory(dir, fakeEmbeddings as any);
const tool = (m: VectorMemory, name: string) => m.tools("t").find((x) => x.spec.name === name)!;

test("ranks the semantically-closest note first (vector beats keyword overlap)", async () => {
  const m = vm(mkdtempSync(join(tmpdir(), "vm-")));
  await tool(m, "remember").run({ note: "The test command is bun test" });
  await tool(m, "remember").run({ note: "Deploys go through the ship skill" });
  await tool(m, "remember").run({ note: "Prefer keyless AWS auth" });

  // Markdown is the source of truth — recall() returns the notes
  expect(m.recall("t")).toContain("bun test");

  // semantic query sharing no keyword with the note → the test note still ranks first
  const res = await tool(m, "memory_search").run({ query: "verify the code works before merging" });
  expect(res.split("\n")[0]).toContain("bun test");
});

test("hybrid: an exact symbol/ID match surfaces even when semantics are uninformative", async () => {
  const m = vm(mkdtempSync(join(tmpdir(), "vm-")));
  await tool(m, "remember").run({ note: "The test command is bun test" });
  await tool(m, "remember").run({ note: "Ticket DELTA-7 tracks the flaky integration suite" });
  // "DELTA-7" embeds to [0,0,0] under the toy embedder (no test/deploy/auth keyword) → cosine 0 for
  // every note, so pure semantic can't rank it. The exact keyword boost surfaces the DELTA-7 note,
  // and the hyphen survives tokenisation (internal symbol chars are kept).
  const res = await tool(m, "memory_search").run({ query: "DELTA-7" });
  expect(res.split("\n")[0]).toContain("DELTA-7");
});

test("self-heals the index from a human edit to MEMORY.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vm-"));
  const m = vm(dir);
  await tool(m, "remember").run({ note: "The test command is bun test" });
  // simulate a human editing MEMORY.md directly (files-first: the file is the truth)
  appendFileSync(join(dir, "t", "MEMORY.md"), "- Releases ship via the deploy pipeline\n");

  const res = await tool(m, "memory_search").run({ query: "how do we release" });
  expect(res).toContain("ship via the deploy pipeline"); // indexed on the fly, then retrieved
});
