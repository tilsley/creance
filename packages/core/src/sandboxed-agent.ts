/**
 * runSandboxedAgent — the "sandboxed agent" execution kind (ADR-0019, Model B).
 * Instead of the runtime driving the think/do loop, a self-contained delegated agent
 * (its `command`) runs INSIDE the sandbox. The split that keeps it governed:
 *
 *   - think  → the agent's inference egress is pointed at the GATEWAY (env below), so
 *              budget / identity / audit still bind (it speaks to the gateway).
 *   - do     → the agent's code execution stays IN the sandbox (isolation binds there).
 *
 * We never route the exec env through the gateway — only inference. The whole delegated
 * run is one opaque `do` from the platform's view; we capture its stdout as the output.
 * (Foreign CLIs that speak OpenAI/Copilot need an OpenAI-compatible gateway endpoint +
 * hard egress lockdown — a follow-up; this runs delegated agents that speak our gateway.)
 */
import type { SandboxSession, TelemetrySink } from "./ports";
import type { AgentSpec } from "./agents";
import type { RunResult } from "./loop";

export interface SandboxedAgentOpts {
  session: SandboxSession;
  task: string;
  spec: AgentSpec;
  /** The sanctioned inference egress — the delegated agent reaches the model ONLY via this. */
  gatewayUrl: string;
  /** Caller identity forwarded into the sandbox so the gateway authenticates + caps it. */
  token?: string;
  telemetry: TelemetrySink;
}

export async function runSandboxedAgent(opts: SandboxedAgentOpts): Promise<RunResult> {
  const { session, task, spec, gatewayUrl, token, telemetry } = opts;
  if (!spec.command) throw new Error(`sandboxed agent '${spec.name}' has no spec.command`);
  const runId = crypto.randomUUID();

  return telemetry.step(
    "agent.sandboxed",
    { "agent.name": spec.name, "sandbox.session": session.id },
    async () => {
      // inject the inference egress: the delegated agent calls the gateway for `think`;
      // its `do` happens locally in the sandbox.
      const env: Record<string, string> = {
        AGENT_TASK: task,
        INFERENCE_GATEWAY_URL: gatewayUrl,
        ...(token ? { AGENT_TOKEN: token } : {}),
      };
      const r = await session.runCmd(spec.command!, { env });
      if (r.exitCode !== 0) {
        // non-zero → throw so the runtime persists status=failed (RunResult has no "failed")
        throw new Error(`sandboxed agent '${spec.name}' exited ${r.exitCode}: ${r.stderr || r.stdout}`);
      }
      return { runId, status: "completed", output: r.stdout.trim() } satisfies RunResult;
    },
  );
}
