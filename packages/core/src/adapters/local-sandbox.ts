/**
 * Local adapter for the SandboxProvider port (do) — runs code on the host via a
 * python3 subprocess. Free, no-AWS, for the swappability demo.
 *
 * ⚠ DEMO ONLY — NO ISOLATION. This runs model-generated code directly on your
 * machine. It exists to prove the port (same loop, different `do` backend); the
 * whole reason production uses AgentCore (Firecracker per session) is to NOT do
 * this. Never point this at untrusted input outside a throwaway dev box.
 *
 * Note: unlike AgentCore's Jupyter-style sessions, this is plain script
 * execution — it returns stdout/stderr only (no last-expression echo), so the
 * model should `print(...)` its results.
 */
import type { SandboxProvider, SandboxSession } from "../ports";

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = "local";

  async startSession(): Promise<SandboxSession> {
    const id = "local-" + Math.random().toString(36).slice(2, 10);
    return {
      id,
      async runCode(code: string): Promise<string> {
        const proc = Bun.spawn(["python3", "-c", code], { stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        return (out + err).trim() || "(no output)";
      },
      async close() {},
    };
  }
}
