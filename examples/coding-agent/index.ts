#!/usr/bin/env bun
/**
 * Coding agent — the platform's first real use case, end to end:
 *
 *   runAgent (L1 loop)
 *     ├─ think  → the governed gateway (verified identity + budget) → Bedrock
 *     └─ do     → run_code / run_cmd / write_file in the SANDBOX (Model A: untrusted code runs there)
 *
 * Multi-turn: it writes code, RUNS it in the sandbox, reads the output, and reports — every
 * `think` metered + identity-checked at the gateway, every `do` confined to the sandbox. This is
 * the spine (examples/spine-agent) plus `workspaceTools`: the agent's actual job, governed.
 *
 * Env (run.sh sets them): INFERENCE_GATEWAY_URL + INFERENCE_GATEWAY_WIRE=openai, AGENT_TOKEN,
 * MODEL_ID, SANDBOX_PROVIDER=local (host python3). Task = CLI args.
 */
import { readFileSync } from "node:fs";
import { providersFromEnv, runAgent, workspaceTools } from "@agent-os/core";

const tenant = process.env.AGENT_TENANT ?? "bob";
const token = process.env.AGENT_TOKEN ?? (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, "utf8").trim() : undefined);
const model = process.env.MODEL_ID ?? "claude-haiku";
const task =
  process.argv.slice(2).join(" ") ||
  "Write a Python script solve.py that prints the sum of the squares of 1..10, run it, and report the number it prints.";

const providers = providersFromEnv();
const runId = `coding-${Date.now()}`;
const inference = await providers.inferenceForTenant(tenant, token, runId, model);

console.log(`▶ coding agent — tenant=${tenant} model=${model} via ${process.env.INFERENCE_GATEWAY_URL}`);
console.log(`  task: "${task}"\n`);

const result = await runAgent({
  inference,
  guard: providers.guard,
  telemetry: providers.telemetry,
  sandbox: providers.sandbox,
  task,
  systemPrompt:
    "You are a coding assistant. Use your tools — write_file to create files, run_cmd / run_code to " +
    "RUN them in the workspace, read_file/list_files to inspect — to actually write and execute code. " +
    "Verify by running it, then report the result in one short line. Stop when done; no extra tool calls.",
  tools: workspaceTools, // run_cmd · read_file · write_file · list_files · run_code — the sandbox `do`
  maxSteps: 8,
  maxOutputTokens: 512,
});

console.log(`\n✅ status=${result.status}`);
console.log(`   output: ${result.output ?? "(none)"}`);
console.log(`   usage:  in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"} tokens`);
if (result.status !== "completed") process.exit(1);
