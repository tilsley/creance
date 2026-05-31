/**
 * Proves the sandboxed-agent kind (ADR-0019, Model B): the delegated command runs in the
 * sandbox with the gateway-egress env injected (think→gateway), its stdout becomes the
 * run output, and a non-zero exit fails the run. The exec stays in the sandbox.
 */
import { test, expect } from "bun:test";
import { runSandboxedAgent } from "./sandboxed-agent";
import type { SandboxSession, CmdResult, RunCmdOptions, TelemetrySink } from "./ports";
import type { AgentSpec } from "./agents";

// telemetry that just runs the step body
const telemetry: TelemetrySink = {
  name: "test",
  async run(_a, fn) { return fn({ setAttrs() {} } as any); },
  async step(_n, _a, fn) { return fn({ setAttrs() {} } as any); },
};

// a fake session that records the last runCmd and returns a scripted result
function fakeSession(result: CmdResult): { session: SandboxSession; seen: { cmd?: string; env?: Record<string, string> } } {
  const seen: { cmd?: string; env?: Record<string, string> } = {};
  const session = {
    id: "sess-1",
    async runCmd(cmd: string, opts?: RunCmdOptions): Promise<CmdResult> {
      seen.cmd = cmd;
      seen.env = opts?.env;
      return result;
    },
    async runCode() { return ""; },
    async readFile() { return ""; },
    async writeFile() {},
    async listFiles() { return []; },
    async fileExists() { return false; },
    async close() {},
  } satisfies SandboxSession;
  return { session, seen };
}

const spec: AgentSpec = { name: "copilot-bot", kind: "sandboxed", command: "run-agent.sh" };

test("runs the command in the sandbox with the gateway-egress env injected", async () => {
  const { session, seen } = fakeSession({ stdout: "the answer\n", stderr: "", exitCode: 0 });
  const result = await runSandboxedAgent({ session, task: "do the thing", spec, gatewayUrl: "http://gw:3100", token: "tok", telemetry });

  expect(result.status).toBe("completed");
  expect(result.output).toBe("the answer"); // stdout, trimmed
  expect(seen.cmd).toBe("run-agent.sh");
  expect(seen.env).toEqual({ AGENT_TASK: "do the thing", INFERENCE_GATEWAY_URL: "http://gw:3100", AGENT_TOKEN: "tok" });
});

test("a non-zero exit throws (run is persisted as failed by the caller)", async () => {
  const { session } = fakeSession({ stdout: "", stderr: "boom", exitCode: 3 });
  await expect(
    runSandboxedAgent({ session, task: "x", spec, gatewayUrl: "http://gw:3100", telemetry }),
  ).rejects.toThrow(/exited 3/);
});

test("requires spec.command", async () => {
  const { session } = fakeSession({ stdout: "", stderr: "", exitCode: 0 });
  await expect(
    runSandboxedAgent({ session, task: "x", spec: { name: "bad", kind: "sandboxed" }, gatewayUrl: "http://gw:3100", telemetry }),
  ).rejects.toThrow(/no spec.command/);
});
