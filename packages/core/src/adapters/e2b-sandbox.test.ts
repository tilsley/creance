/**
 * Proves the E2B SandboxProvider adapter (ADR-0019) maps the port to the E2B SDK shape,
 * via an injected fake box — no SDK or API key needed. A live run is gated on E2B_API_KEY.
 */
import { test, expect } from "bun:test";
import { E2BSandboxProvider, type E2BBox } from "./e2b-sandbox";

function fakeBox(): { box: E2BBox; calls: any } {
  const calls: any = { cmds: [], writes: [], killed: false };
  const box: E2BBox = {
    sandboxId: "sbx-123",
    async runCode(code) {
      return { logs: { stdout: ["line1", "line2"] }, text: "result" };
    },
    commands: {
      async run(cmd, opts) {
        calls.cmds.push({ cmd, opts });
        if (cmd.startsWith("find")) return { stdout: "./a.txt\n./dir/b.txt\n", stderr: "", exitCode: 0 };
        if (cmd.includes("__E__")) return { stdout: "__E__\n", stderr: "", exitCode: 0 };
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    },
    files: {
      async read(path) { return `contents of ${path}`; },
      async write(path, data) { calls.writes.push({ path, data }); return {}; },
    },
    async kill() { calls.killed = true; return {}; },
  };
  return { box, calls };
}

test("startSession returns a SandboxSession bound to the E2B sandbox id", async () => {
  const { box } = fakeBox();
  const s = await new E2BSandboxProvider({ create: async () => box }).startSession();
  expect(s.id).toBe("sbx-123");
});

test("runCmd maps to commands.run and forwards env + returns {stdout,stderr,exitCode}", async () => {
  const { box, calls } = fakeBox();
  const s = await new E2BSandboxProvider({ create: async () => box }).startSession();
  const r = await s.runCmd("echo hi", { env: { FOO: "bar" }, timeoutMs: 1000 });
  expect(r).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
  expect(calls.cmds[0]).toEqual({ cmd: "echo hi", opts: { envs: { FOO: "bar" }, timeoutMs: 1000 } });
});

test("runCode combines stdout logs + text", async () => {
  const { box } = fakeBox();
  const s = await new E2BSandboxProvider({ create: async () => box }).startSession();
  expect(await s.runCode("print(1)")).toBe("line1\nline2\nresult");
});

test("read/write map to files; listFiles uses find; close kills the box", async () => {
  const { box, calls } = fakeBox();
  const s = await new E2BSandboxProvider({ create: async () => box }).startSession();
  expect(await s.readFile("x.txt")).toBe("contents of x.txt");
  await s.writeFile("y.txt", "data");
  expect(calls.writes[0]).toEqual({ path: "y.txt", data: "data" });
  expect(await s.listFiles()).toEqual(["a.txt", "dir/b.txt"]); // ./ stripped
  expect(await s.fileExists("a.txt")).toBe(true);
  await s.close();
  expect(calls.killed).toBe(true);
});
