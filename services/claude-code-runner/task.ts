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
import { LoopDetector } from "./loop-detector";

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

/** Run a git command in the workspace, throwing with stderr on failure. */
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** The egress sidecar (ADR-0034) is this container's only route to GitHub — wait
 *  for it before cloning (containers start together; registry reads take a beat). */
async function waitForSidecar(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`egress sidecar not healthy at ${base} after ${timeoutMs}ms`);
}

const run = await store.get(runId);
if (!run) {
  console.error(`claude-code-runner: unknown run ${runId}`);
  process.exit(2);
}
const spec = run.agent ? await registry.get(run.agent) : undefined;

const workspace = `${process.env.WORKSPACE_DIR ?? `${process.env.HOME}/workspace`}/run-${runId}`;
const branch = `run/${runId}`;
const gitBase = process.env.GIT_PROXY_URL ?? "http://localhost:8081";
// The target repo is the RUN's (a gate-authorized resource, ADR-0034 refinement) —
// the agent is repo-agnostic; which repo a principal may target is authz's call.
const repo = run.repo;
// The sidecar is now the only route to GitHub AND the inference API (the real
// subscription token lives there) — every run needs it up before the harness starts.
await waitForSidecar(gitBase);
if (repo) {
  // Clone THROUGH the sidecar: the remote is localhost, the PAT never enters this
  // container, and the sidecar's allowlist means this repo is the only one reachable.
  git(process.env.HOME!, "clone", `${gitBase}/${repo}.git`, workspace);
  git(workspace, "checkout", "-b", branch);
  git(workspace, "config", "user.name", "agent-os claude-code runner");
  git(workspace, "config", "user.email", "agent-os-claude-code@tilsley.dev");
} else {
  await mkdir(workspace, { recursive: true });
}

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
  [
    spec?.systemPrompt,
    UNATTENDED,
    repo &&
      `The working directory is a clone of ${repo}, already on branch ${branch}. ` +
        "Commit your work with clear messages as you go; do NOT push — the platform pushes your branch after you finish.",
  ]
    .filter(Boolean)
    .join("\n\n"),
  ...(spec?.model ? ["--model", spec.model] : []),
];

console.log(`claude-code-runner: run ${runId} agent=${run.agent ?? "(none)"} workspace=${workspace}`);
await store.update(runId, { status: "running" });

let terminal: { status: RunStatus; output?: string; error?: string; usage?: TokenUsage; costUsd?: number } | undefined;
const messages: Message[] = [{ role: "user", text: run.task }];
// Set when WE stop the process early (loop detector) so the terminal status reflects
// the reason instead of looking like a bare non-zero exit. CC_LOOP_THRESHOLD tunes it.
let stoppedEarly: { status: RunStatus; error: string } | undefined;
const loop = new LoopDetector(Number(process.env.CC_LOOP_THRESHOLD ?? 5));

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
        // Inner bound (ADR-0037): a run spinning on identical tool calls is stuck —
        // stop it before it burns its turn budget / a quota slot for no progress.
        for (const call of message.toolCalls ?? []) {
          const reason = loop.record(call.name, call.input);
          if (reason) {
            console.error(`claude-code-runner: run ${runId} ${reason} — killing`);
            stoppedEarly = { status: "stuck", error: reason };
            proc.kill();
            break;
          }
        }
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
    terminal = stoppedEarly ?? {
      status: "failed",
      error: exitCode === 0 ? "claude produced no result event" : `claude exited with code ${exitCode} (timeout or crash)`,
    };
  }
} catch (e: any) {
  terminal = { status: "failed", error: e?.message ?? String(e) };
}

// Push the run branch (through the sidecar — the only container with the PAT
// keeps its own policy: run/* branches only). A crashed run still pushes whatever
// was committed, so partial work is inspectable rather than lost with the task.
if (repo) {
  try {
    const dirty = git(workspace, "status", "--porcelain");
    if (dirty) {
      git(workspace, "add", "-A");
      git(workspace, "commit", "-m", `chore: uncommitted changes at end of run ${runId}`);
    }
    const ahead = Number(git(workspace, "rev-list", "--count", "HEAD", "--not", "--remotes"));
    if (ahead > 0) {
      git(workspace, "push", "origin", branch);
      console.log(`claude-code-runner: pushed ${branch} (${ahead} commit${ahead === 1 ? "" : "s"})`);
      terminal.output = `${terminal.output ?? ""}\n\n[pushed ${repo}@${branch} — ${ahead} commit${ahead === 1 ? "" : "s"}]`.trim();
      // Open the PR through the sidecar's one REST capability (POST .../pulls on the
      // allowed repo). Non-fatal: the pushed branch is the deliverable, the PR is sugar.
      try {
        const base = git(workspace, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
        const title = git(workspace, "log", "-1", "--format=%s");
        const res = await fetch(`${gitBase}/api/repos/${repo}/pulls`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title,
            head: branch,
            base,
            body: `agent-os run \`${runId}\` (agent \`${run.agent}\`)\n\n**Task:**\n${run.task}`,
          }),
        });
        const pr: any = await res.json();
        if (!res.ok) throw new Error(pr?.errors?.[0]?.message ?? pr?.message ?? `HTTP ${res.status}`);
        console.log(`claude-code-runner: opened PR ${pr.html_url}`);
        terminal.output = `${terminal.output}\n[PR: ${pr.html_url}]`;
      } catch (e: any) {
        console.error(`claude-code-runner: PR creation failed: ${e?.message ?? e}`);
        terminal.output = `${terminal.output}\n[PR creation failed: ${e?.message ?? e}]`;
      }
    } else {
      console.log(`claude-code-runner: no commits on ${branch}, nothing to push`);
    }
  } catch (e: any) {
    // a push failure shouldn't overwrite a successful run — annotate it instead
    terminal.output = `${terminal.output ?? ""}\n\n[push of ${branch} FAILED: ${e?.message ?? e}]`.trim();
    console.error(`claude-code-runner: push failed: ${e?.message ?? e}`);
  }
}

await store.update(runId, { ...terminal, messages });
console.log(`claude-code-runner: run ${runId} finished status=${terminal.status}`);
process.exit(terminal.status === "failed" ? 1 : 0);
