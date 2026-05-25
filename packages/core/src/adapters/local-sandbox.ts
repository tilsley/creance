/**
 * Local adapter for the SandboxProvider port (do) — a real workspace on the host:
 * a temp working dir + bash + file I/O. Free, no-AWS, great for dev.
 *
 * ⚠ DEMO/DEV ONLY — NO ISOLATION. Runs model-generated code/commands directly on
 * your machine. Production uses AgentCore (Firecracker per session) precisely to
 * avoid this. Never point it at untrusted input outside a throwaway dev box.
 */
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Glob } from "bun";
import type {
  SandboxProvider,
  SandboxSession,
  CmdResult,
  RunCmdOptions,
} from "../ports";

export class LocalSandboxProvider implements SandboxProvider {
  readonly name = "local";

  async startSession(): Promise<SandboxSession> {
    const workdir = await mkdtemp(join(tmpdir(), "agent-os-"));
    const abs = (p: string) => join(workdir, p);

    return {
      id: `local-${workdir.split(/[-/]/).pop()}`,

      async runCode(code: string): Promise<string> {
        const p = Bun.spawn(["python3", "-c", code], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
        const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        await p.exited;
        return (o + e).trim() || "(no output)";
      },

      async runCmd(cmd: string, opts?: RunCmdOptions): Promise<CmdResult> {
        const p = Bun.spawn(["bash", "-lc", cmd], {
          cwd: workdir,
          env: { ...process.env, ...opts?.env },
          stdout: "pipe",
          stderr: "pipe",
          timeout: opts?.timeoutMs,
        });
        const [stdout, stderr] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
        ]);
        const exitCode = await p.exited;
        return { stdout, stderr, exitCode };
      },

      readFile: (path: string) => readFile(abs(path), "utf8"),

      async writeFile(path: string, content: string): Promise<void> {
        await mkdir(dirname(abs(path)), { recursive: true });
        await writeFile(abs(path), content);
      },

      async listFiles(): Promise<string[]> {
        const out: string[] = [];
        for await (const f of new Glob("**/*").scan({ cwd: workdir, onlyFiles: true })) {
          if (!f.includes("node_modules/") && !f.startsWith(".git/") && !f.includes("/.git/")) {
            out.push(f);
          }
        }
        return out;
      },

      fileExists: (path: string) => Bun.file(abs(path)).exists(),

      async close(): Promise<void> {
        await rm(workdir, { recursive: true, force: true });
      },
    };
  }
}
