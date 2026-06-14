#!/usr/bin/env bun
/**
 * Coding agent WITH files-first memory (ADR-0030) — a coding agent that REMEMBERS across runs.
 *
 *   think  → the governed inference gateway → Bedrock        (the platform's coding agent)
 *   do     → workspace tools in the sandbox                  (the task)
 *   remember → durable Markdown memory (MEMORY.md), outside the ephemeral sandbox
 *
 * Long-term memory is plain Markdown the agent reads (loaded into the system prompt at start) and
 * writes (the `remember` tool). Run it twice with the same AGENT_MEMORY_DIR: run 1 learns + saves,
 * run 2 — a FRESH session — recalls without being re-told. The memory is human-readable: `cat` it.
 *
 * Env: INFERENCE_GATEWAY_URL + INFERENCE_GATEWAY_WIRE, AGENT_TOKEN, AGENT_TENANT, MODEL_ID,
 *      AGENT_MEMORY_DIR (durable per-tenant memory root), SANDBOX_PROVIDER=local. Task = CLI args.
 */
import { readFileSync } from "node:fs";
import { providersFromEnv, runAgent, workspaceTools, FilesMemory } from "@agent-os/core";

const tenant = process.env.AGENT_TENANT ?? "bob";
const token =
  process.env.AGENT_TOKEN ??
  (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, "utf8").trim() : undefined);
const model = process.env.MODEL_ID ?? "claude-haiku";
const memory = new FilesMemory(process.env.AGENT_MEMORY_DIR ?? "./.agent-memory");
const task = process.argv.slice(2).join(" ") || "Tell me what you remember about this project.";

const providers = providersFromEnv();
const runId = `cam-${Date.now()}`;
const inference = await providers.inferenceForTenant(tenant, token, runId, model);

const recalled = memory.recall(tenant);
console.log(`▶ coding agent + memory — tenant=${tenant} via ${process.env.INFERENCE_GATEWAY_URL}`);
console.log(`  memory loaded: ${recalled ? recalled.split("\n").filter(Boolean).length + " note(s)" : "(empty — first run)"}`);
console.log(`  task: "${task}"\n`);

const result = await runAgent({
  inference,
  guard: providers.guard,
  telemetry: providers.telemetry,
  sandbox: providers.sandbox,
  task,
  systemPrompt:
    "You are a coding assistant with DURABLE memory across sessions.\n" +
    (recalled ? `\n## Your memory (from past sessions):\n${recalled}\n` : "\n(Your memory is empty so far.)\n") +
    "\nUse the `remember` tool to save durable facts, decisions, and preferences worth keeping for future " +
    "sessions; use `memory_search` to look them up; use your workspace tools for the task itself. " +
    "Answer concisely, then stop — no extra tool calls.",
  // working memory = the sandbox session; semantic memory = the durable files adapter
  tools: (session) => [...workspaceTools(session), ...memory.tools(tenant)],
  maxSteps: 8,
  maxOutputTokens: 512,
});

console.log(`\n✅ status=${result.status}`);
console.log(`   output: ${result.output ?? "(none)"}`);
console.log(`   usage:  in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"} tokens`);
if (result.status !== "completed") process.exit(1);
