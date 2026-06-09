#!/usr/bin/env bun
/**
 * Spine agent — the smallest REAL agent that exercises the platform end to end:
 *
 *   runAgent (L1 loop) → think via the inference gateway (verified identity + budget)
 *                      → Bedrock → answer
 *
 * Think-only (no tools), so the loop returns after one turn. This is the first thing
 * that proves the runtime ↔ gateway ↔ model path through an ACTUAL agent loop rather
 * than curl: the agent holds no model creds; its identity (AGENT_TOKEN) is forwarded to
 * the gateway, which authenticates it, checks its claim/budget, and calls the model.
 *
 * Env (set by run.sh): INFERENCE_GATEWAY_URL + INFERENCE_GATEWAY_WIRE=openai (talk to the
 * LiteLLM gateway), AGENT_TOKEN (the verified identity), MODEL_ID (the claim's model),
 * SANDBOX_PROVIDER=local (the loop owns a session). Task = the CLI args.
 */
import { readFileSync } from "node:fs";
import { providersFromEnv, runAgent } from "@agent-os/core";

const tenant = process.env.AGENT_TENANT ?? "bob";
// AGENT_TOKEN (env, local) or AGENT_TOKEN_FILE (a mounted projected SA token, in-pod).
const token = process.env.AGENT_TOKEN ?? (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, "utf8").trim() : undefined);
const model = process.env.MODEL_ID ?? "claude-haiku";
const task = process.argv.slice(2).join(" ") || "In one word, what is the capital of France?";

const providers = providersFromEnv();
const runId = `spine-${Date.now()}`;
// the gateway-pointed InferenceProvider for this tenant — the agent's identity rides along
const inference = await providers.inferenceForTenant(tenant, token, runId, model);

console.log(`▶ spine agent — tenant=${tenant} model=${model} via ${process.env.INFERENCE_GATEWAY_URL}`);
console.log(`  task: "${task}"\n`);

const result = await runAgent({
  inference,
  guard: providers.guard,
  telemetry: providers.telemetry,
  sandbox: providers.sandbox,
  task,
  systemPrompt: "You are a terse assistant. Answer the question directly in as few words as possible.",
  tools: () => [], // think-only: no tools, so the loop returns as soon as the model answers
  maxSteps: 2,
  maxOutputTokens: 64,
});

console.log(`\n✅ status=${result.status}`);
console.log(`   output: ${result.output ?? "(none)"}`);
console.log(`   usage:  in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"} tokens`);
if (result.status !== "completed") process.exit(1);
