#!/usr/bin/env bun
/**
 * doc-gardener — the platform's first OpenCode-engine agent, end to end:
 *
 *   inventory + deterministic drift detectors  (no LLM: discovery is mechanical)
 *     → ONE OpenCode session via the governed gateway  (judgement: fix the docs)
 *       → docs-only write allowlist  (whatever happened in the session, only doc edits survive)
 *         → report (+ diff)
 *
 * The engine is bought (OpenCode: loop, file tools, prompt plumbing); the governance is
 * ours (gateway identity + budget, tool denial, write allowlist) — the same split as the
 * LiteLLM pivot (ADR-0024/0025), one layer up.
 *
 * Workspace, in order: TARGET_REPO_URL (clone it) > WORKSPACE (use it in place).
 * Identity/model env is the platform convention: INFERENCE_GATEWAY_URL, MODEL_ID,
 * AGENT_TOKEN/AGENT_TOKEN_FILE (cheap mode) or neither (full/mesh mode).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectDrift, type RepoInventory } from "./detectors";
import { enforceAllowlist, isDocPath, changedPaths } from "./allowlist";
import { runDocSession } from "./opencode-session";

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
}

function resolveWorkspace(): string {
  const url = process.env.TARGET_REPO_URL;
  if (url) {
    const dir = "/tmp/doc-gardener-workspace";
    execFileSync("rm", ["-rf", dir]);
    execFileSync("git", ["clone", "--depth", "1", url, dir], { stdio: "inherit" });
    return dir;
  }
  const ws = process.env.WORKSPACE;
  if (ws && existsSync(join(ws, ".git"))) return ws;
  if (process.env.FIXTURE_DIR) {
    // self-contained demo mode (the k8s Job): copy the baked-in drifted fixture to a
    // writable dir and make it a repo — the allowlist needs git to know what changed
    const dir = "/tmp/doc-gardener-fixture";
    execFileSync("rm", ["-rf", dir]);
    execFileSync("cp", ["-R", process.env.FIXTURE_DIR, dir]);
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "-c", "user.email=fixture@agent-os", "-c", "user.name=fixture", "add", "-A"]);
    execFileSync("git", ["-C", dir, "-c", "user.email=fixture@agent-os", "-c", "user.name=fixture", "commit", "-qm", "fixture"]);
    return dir;
  }
  console.error("no workspace: set TARGET_REPO_URL (clone), WORKSPACE (existing checkout), or FIXTURE_DIR (demo)");
  process.exit(2);
}

function collectInventory(ws: string): RepoInventory {
  const read = (p: string) => (existsSync(join(ws, p)) ? readFileSync(join(ws, p), "utf8") : undefined);
  const pkg = read("package.json");
  return {
    readme: read("README.md"),
    scripts: pkg ? ((JSON.parse(pkg).scripts as Record<string, string>) ?? {}) : {},
    envVars: (read(".env.example") ?? "")
      .split("\n")
      .map((l) => l.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((v): v is string => !!v),
    files: git(ws, "ls-files").split("\n").filter(Boolean),
  };
}

const workspace = resolveWorkspace();
const inventory = collectInventory(workspace);
const drift = detectDrift(inventory);

console.log(`▶ doc-gardener — workspace=${workspace} model=${process.env.MODEL_ID ?? "claude-haiku"} via ${process.env.INFERENCE_GATEWAY_URL ?? "http://localhost:4000"}`);
console.log(`  drift detected (${drift.length}):`);
for (const d of drift) console.log(`   - [${d.severity}] ${d.type}: ${d.detail}`);

if (drift.length === 0) {
  console.log("\n✅ no drift — nothing to do");
  process.exit(0);
}

const prompt = [
  "You are a documentation gardener. Fix the documentation drift listed below by editing",
  "ONLY documentation files (*.md, *.mdx, or files under docs/). Never touch source code,",
  "configuration, or CI files — if a finding seems to need a code change, document the",
  "current behaviour instead. Keep edits minimal and factual; match the existing tone.",
  "Verify claims against the actual files before writing them.",
  "",
  "Drift findings:",
  ...drift.map((d) => `- ${d.type}: ${d.detail}`),
  "",
  "When you are done, summarise what you changed in a few short bullet points.",
].join("\n");

const result = await runDocSession(workspace, prompt);

// an empty session means the model was never reached (opencode swallows provider errors
// into the session) — fail loudly rather than report a clean run that did nothing
if (result.tokens.output === 0 && result.toolCalls.length === 0) {
  console.error("\n❌ the session produced nothing — the gateway likely rejected the call (check its logs)");
  process.exit(1);
}

console.log(`\n  session: ${result.toolCalls.length} tool calls, in=${result.tokens.input} out=${result.tokens.output} tokens, ~$${result.costUsd.toFixed(4)}`);
for (const t of result.toolCalls) console.log(`   - ${t.tool}${t.title ? `: ${t.title}` : ""}`);

const reverted = enforceAllowlist(workspace);
if (reverted.length) console.log(`\n  ⛔ allowlist reverted non-doc changes: ${reverted.join(", ")}`);

const changed = changedPaths(git(workspace, "status", "--porcelain", "-z")).filter(isDocPath);
console.log(`\n  docs changed (${changed.length}): ${changed.join(", ") || "(none)"}`);
console.log(`\n  agent summary:\n${result.text.replace(/^/gm, "    ")}`);

if (changed.length && process.env.SHOW_DIFF !== "0") {
  console.log(`\n--- diff ---\n${git(workspace, "diff")}`);
}

console.log(`\n✅ status=completed`);
// force the exit: the opencode server's surviving pipes/children otherwise hold Bun's
// event loop open in a container, and the Job never completes
process.exit(0);
