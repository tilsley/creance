/**
 * claude-code-runner task — one Run as one headless Claude Code invocation (ADR-0033).
 *
 * The serverless dispatch seam (ADR-0031) launches this for agents with
 * kind="claude-code": same RUN_ID container-override contract as the loop executor
 * (task.ts), same runs table, same GET /runs/{id} polling — but instead of the L1
 * think/do loop, the run body is `claude -p <task>` with the harness owning
 * think+do inside this container. Auth is the operator's Claude subscription:
 * CLAUDE_CODE_OAUTH_TOKEN arrives as an ECS container secret from SSM.
 *
 * The stream-json events are mirrored into the run's messages as they happen, so
 * the console's ~1s poll reads like a live transcript — the exact watch model the
 * loop executor already has (per-turn persisted state, no SSE/bus needed).
 *
 *   RUN_ID=<uuid> bun run services/claude-code-runner/task.ts
 */
import { mkdir } from "node:fs/promises";
import {
  DynamoAgentRegistry,
  DynamoDBRunStore,
  type Message,
  type RunStatus,
  type TokenUsage,
} from "@agent-os/core";

const runId = process.env.RUN_ID ?? process.argv[2];
if (!runId) {
  console.error("claude-code-runner: no run id (set RUN_ID or pass it as the first arg)");
  process.exit(2);
}

const region = process.env.REGION ?? "eu-west-2";
// Only state, deliberately: no inference/sandbox providers — Claude Code IS the loop,
// so providersFromEnv would build (and misleadingly log) machinery this task never uses.
const store = new DynamoDBRunStore(process.env.RUNS_TABLE ?? "agent-os-runs", region, process.env.RUNS_TABLE_ENDPOINT);
const registry = new DynamoAgentRegistry(process.env.AGENTS_TABLE ?? "agent-os-agents", region, process.env.AGENTS_TABLE_ENDPOINT);

// A hung harness burns Fargate-seconds; for a cost-sensitive POC a hard kill that
// surfaces as status=failed beats an open-ended task (same stance as task.ts's exit).
const timeoutMs = Number(process.env.CC_TIMEOUT_MS ?? 30 * 60 * 1000);
// DynamoDB items cap at 400KB — keep the mirrored transcript comfortably under it.
const TOOL_OUTPUT_CAP = 4_000;

// The one behavioural addition every run gets: the harness must not wait on a human.
const UNATTENDED =
  "You are running unattended in an agent-os Fargate task; no one can answer questions or " +
  "approve actions mid-run. Make reasonable assumptions, state them in your final summary, " +
  "and keep all work inside the current working directory.";

/** One stream-json event → zero/one neutral Message (assistant turns + tool results). */
function toMessage(event: any): Message | undefined {
  if (event.type === "assistant") {
    const content: any[] = event.message?.content ?? [];
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("") || undefined;
    const toolCalls = content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    if (!text && !toolCalls.length) return undefined;
    return { role: "assistant", text, ...(toolCalls.length ? { toolCalls } : {}) };
  }
  if (event.type === "user") {
    const results = (event.message?.content ?? [])
      .filter((b: any) => b.type === "tool_result")
      .map((b: any) => ({
        toolCallId: b.tool_use_id,
        output: (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")).slice(0, TOOL_OUTPUT_CAP),
      }));
    if (!results.length) return undefined;
    return { role: "tool", results };
  }
  return undefined;
}

const run = await store.get(runId);
if (!run) {
  console.error(`claude-code-runner: unknown run ${runId}`);
  process.exit(2);
}
const spec = run.agent ? await registry.get(run.agent) : undefined;

const workspace = `${process.env.WORKSPACE_DIR ?? `${process.env.HOME}/workspace`}/run-${runId}`;
await mkdir(workspace, { recursive: true });

const cmd = [
  "claude",
  "-p",
  run.task,
  "--output-format",
  "stream-json",
  "--verbose", // required by stream-json in print mode
  "--permission-mode",
  "bypassPermissions", // the container is the sandbox; requires the non-root image user
  "--max-turns",
  String(spec?.maxSteps ?? 30),
  "--append-system-prompt",
  [spec?.systemPrompt, UNATTENDED].filter(Boolean).join("\n\n"),
  ...(spec?.model ? ["--model", spec.model] : []),
];

console.log(`claude-code-runner: run ${runId} agent=${run.agent ?? "(none)"} workspace=${workspace}`);
await store.update(runId, { status: "running" });

let terminal: { status: RunStatus; output?: string; error?: string; usage?: TokenUsage; costUsd?: number } | undefined;
const messages: Message[] = [{ role: "user", text: run.task }];

try {
  const proc = Bun.spawn({
    cmd,
    cwd: workspace,
    env: { ...process.env, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    stdout: "pipe",
    stderr: "inherit", // harness diagnostics -> CloudWatch
  });
  const killer = setTimeout(() => {
    console.error(`claude-code-runner: run ${runId} exceeded ${timeoutMs}ms — killing`);
    proc.kill();
  }, timeoutMs);

  // Mirror the event stream into the run record as it happens (durable per-turn state,
  // the loop executor's onProgress equivalent). Sequential awaits keep updates ordered.
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // not an event line — ignore
      }
      const message = toMessage(event);
      if (message) {
        messages.push(message);
        await store.update(runId, { messages }).catch(() => {});
      }
      if (event.type === "result") {
        terminal = {
          status: event.is_error ? "failed" : "completed",
          output: typeof event.result === "string" ? event.result : undefined,
          error: event.is_error ? (event.result ?? event.subtype ?? "claude exited with an error") : undefined,
          usage: event.usage
            ? { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens }
            : undefined,
          // subscription auth reports $0 — kept for the record; API/Bedrock auth reports real spend
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
        };
      }
    }
  }

  const exitCode = await proc.exited;
  clearTimeout(killer);
  if (!terminal) {
    terminal = {
      status: "failed",
      error: exitCode === 0 ? "claude produced no result event" : `claude exited with code ${exitCode} (timeout or crash)`,
    };
  }
} catch (e: any) {
  terminal = { status: "failed", error: e?.message ?? String(e) };
}

await store.update(runId, { ...terminal, messages });
console.log(`claude-code-runner: run ${runId} finished status=${terminal.status}`);
process.exit(terminal.status === "failed" ? 1 : 0);
