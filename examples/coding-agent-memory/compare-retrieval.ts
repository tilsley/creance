#!/usr/bin/env bun
/**
 * Vector vs keyword memory retrieval (ADR-0030 / ADR-0027 profiles) — why the full profile exists.
 * Seeds the same Markdown memory, then runs ONE query that shares no keyword with the relevant note
 * through both adapters: keyword search (cheap) misses; vector search (Bedrock Titan) finds it by
 * meaning. Same files, two indexes — the Markdown stays the source of truth.
 *
 *   bun run examples/coding-agent-memory/compare-retrieval.ts     (needs Bedrock embeddings)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesMemory, VectorMemory } from "@agent-os/core";

const dir = mkdtempSync(join(tmpdir(), "mem-cmp-"));
const tenant = "demo";
const vector = new VectorMemory(dir);
const keyword = new FilesMemory(dir); // SAME dir → both read the same MEMORY.md

// seed: VectorMemory.remember writes MEMORY.md (the truth) + the embedding index
const remember = vector.tools(tenant).find((t) => t.spec.name === "remember")!;
for (const note of [
  "The test command is bun test",
  "Deploys go through the ship skill, never raw kubectl",
  "Prefer keyless AWS auth via Pod Identity, never static keys",
]) {
  await remember.run({ note });
}

// a query that shares NO keyword with "The test command is bun test", but means the same thing
const query = "How do I verify the code works before merging a change?";
const kwSearch = keyword.tools(tenant).find((t) => t.spec.name === "memory_search")!;
const veSearch = vector.tools(tenant).find((t) => t.spec.name === "memory_search")!;

console.log(`memory:\n${vector.recall(tenant)}`);
console.log(`\nquery: "${query}"\n`);

const kw = await kwSearch.run({ query });
const ve = await veSearch.run({ query });
console.log("── keyword (cheap profile · FilesMemory) ──");
console.log(kw);
console.log("\n── vector (full profile · VectorMemory + Titan embeddings) ──");
console.log(ve);

// verdict (so this doubles as a regression check, not just a demo): the no-keyword query MUST miss
// under keyword and MUST surface the test note first under vector. That gap is the reason the full
// profile exists.
const kwMissed = kw.includes("(no matching memory)");
const veFound = (ve.split("\n")[0] ?? "").includes("bun test");
console.log("\n──────── verdict ────────");
console.log(kwMissed ? "✅ keyword MISSED (no shared keyword) — as expected" : `❌ keyword unexpectedly matched: ${kw}`);
console.log(veFound ? "✅ vector FOUND it by meaning (test note ranked first)" : `❌ vector did not rank the test note first:\n${ve}`);
if (kwMissed && veFound) {
  console.log("✅ semantic edge proven — vector recalls what keyword can't.");
  process.exit(0);
}
console.log("❌ FAILED — the semantic-edge contrast did not hold.");
process.exit(1);
