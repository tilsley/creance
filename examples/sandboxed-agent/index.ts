#!/usr/bin/env bun
/**
 * Sandboxed agent — Model B (ADR-0020/0022), the "foreign agent in a box". A REAL foreign coding
 * CLI (Claude Code) runs INSIDE the sandbox as an opaque delegated agent; the runtime only
 * launches-and-watches (runSandboxedAgent), it does NOT drive the think/do loop.
 *
 *   runSandboxedAgent
 *     ├─ think → Claude Code → the gateway's Anthropic /v1/messages wire → Bedrock   (governed)
 *     └─ do    → Claude Code's write/bash tools stay IN the sandbox                  (contained)
 *
 * The split that keeps it governed: only inference egress is pointed at the gateway (the wrapper
 * maps the injected env onto Claude Code's ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN). Execution
 * stays in the sandbox; in-cluster the egress wall makes the gateway the agent's ONLY outbound,
 * so a `do` reaching anywhere else is refused (the Model-A proof, now one level up). We hold no
 * model creds — identity is the projected SA token the gateway verifies. The whole CLI loop is
 * one opaque `do`; we capture its stdout as the run output and verify the artifact it produced.
 *
 * Env (the pod / run.sh set them): INFERENCE_GATEWAY_URL, AGENT_TOKEN(_FILE), SANDBOX_PROVIDER=local.
 * Task = CLI args.
 */
import { readFileSync } from "node:fs";
import { providersFromEnv, runSandboxedAgent } from "@agent-os/core";

const token =
  process.env.AGENT_TOKEN ??
  (process.env.AGENT_TOKEN_FILE ? readFileSync(process.env.AGENT_TOKEN_FILE, "utf8").trim() : undefined);
const gatewayUrl = process.env.INFERENCE_GATEWAY_URL ?? "http://localhost:4000";
const task =
  process.argv.slice(2).join(" ") ||
  "Create a file named answer.txt whose only contents are the sum of the squares of 1..10 (one number, no other text). " +
    "Then try an HTTPS GET to https://example.com with a 5-second timeout and tell me whether it succeeded or was blocked — " +
    "treat a blocked network as expected, not an error. Finish in one short line.";

const providers = providersFromEnv();
const session = await providers.sandbox.startSession();

console.log(`▶ sandboxed agent (Model B) — Claude Code in the sandbox, inference via ${gatewayUrl}`);
console.log(`  task: "${task}"\n`);

try {
  const result = await runSandboxedAgent({
    session,
    task,
    // the foreign CLI is launched, not loop-driven; the wrapper next to this file is the shim.
    spec: { name: "claude-code-agent", kind: "sandboxed", command: `bash ${import.meta.dir}/run-claude.sh` },
    gatewayUrl,
    token,
    telemetry: providers.telemetry,
  });

  // strong assertion #1 (governed think): the delegated agent produced the artifact via the gateway
  const answer = (await session.fileExists("answer.txt")) ? (await session.readFile("answer.txt")).trim() : "(absent)";

  // strong assertion #2 (containment) — DETERMINISTIC, no LLM prose to parse: the launcher shares
  // this pod and the egress wall with the foreign agent, so the launcher's own outbound being
  // refused proves the agent's is too. In-cluster the wall blocks it (NET_BLOCKED); locally it won't.
  let egress: string;
  try {
    const r = await fetch("https://example.com", { signal: AbortSignal.timeout(5000) });
    egress = `NET_OK ${r.status}`;
  } catch (e) {
    egress = `NET_BLOCKED ${(e as Error).message}`;
  }

  console.log(`\n✅ status=${result.status}`);
  console.log(`   agent output:\n${result.output ?? "(none)"}`);
  console.log(`\n   answer.txt in the sandbox: ${answer}`);
  console.log(`   egress probe from the pod:  ${egress}`);
} finally {
  await session.close();
}
