/**
 * Proves the coder loop's credential + workspace seams (ADR-0046):
 *   - the App JWT is a verifiable RS256 token with GitHub's iat/exp shape;
 *   - the workspace lifecycle clones after claim, pushes run/<id> when HEAD moved,
 *     stays quiet when it didn't, and never writes the token to disk (.git/config);
 *   - the dispatch envelope carries the token per substrate (env override /
 *     invoke payload) and never onto the Run record.
 */
import { test, expect } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import type { Run } from "@agent-os/core";
import { appJwt } from "./github-app";
import { cloneCoderWorkspace } from "./coder-workspace";
import { agentCoreDispatch, type AgentCoreDispatchConfig } from "./dispatch";

// --- appJwt -----------------------------------------------------------------

test("appJwt is RS256-verifiable with GitHub's claim shape", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string; // GitHub ships PKCS#1
  const jwt = appJwt("12345", pem, 1_700_000_000);
  const [h, p, s] = jwt.split(".");
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
  expect(claims).toEqual({ iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "12345" });
  const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, "base64url"));
  expect(ok).toBe(true);
});

// --- workspace lifecycle ----------------------------------------------------

/** A scripted sandbox session: maps a command substring to its result. */
function fakeSession(script: Record<string, { exitCode?: number; stdout?: string }>) {
  const commands: string[] = [];
  return {
    commands,
    session: {
      id: "s1",
      runCmd: async (cmd: string) => {
        commands.push(cmd);
        const hit = Object.entries(script).find(([k]) => cmd.includes(k));
        return { exitCode: hit?.[1].exitCode ?? 0, stdout: hit?.[1].stdout ?? "", stderr: "" };
      },
    } as any,
  };
}

test("clone → edit → finalize pushes run/<id>, with the token only ever in extraheader", async () => {
  const { session, commands } = fakeSession({
    "rev-parse HEAD": { stdout: "aaaa1111\n" },
    "rev-parse origin/HEAD": { stdout: "bbbb2222\n" }, // HEAD moved ⇒ push
  });
  const ws = await cloneCoderWorkspace(session, "tilsley/scratch", "ghs_tok", "run-1");
  const note = await ws.finalize();
  expect(note).toContain("tilsley/scratch@run/run-1");
  expect(commands[0]).toContain("clone --depth 50 https://github.com/tilsley/scratch.git .");
  const push = commands.find((c) => c.includes("push"));
  expect(push).toContain("refs/heads/run/run-1");
  expect(push).not.toContain("ghs_tok"); // basic-auth b64 in extraheader, never the raw token
  // the token must never be persisted where read_file could reach it
  expect(commands.some((c) => c.includes("credential") || c.includes("askpass"))).toBe(false);
});

test("an unchanged workspace pushes nothing", async () => {
  const { session, commands } = fakeSession({
    "rev-parse HEAD": { stdout: "same\n" },
    "rev-parse origin/HEAD": { stdout: "same\n" },
  });
  const ws = await cloneCoderWorkspace(session, "tilsley/scratch", "t", "run-2");
  expect(await ws.finalize()).toContain("nothing pushed");
  expect(commands.some((c) => c.includes("push"))).toBe(false);
});

test("a failed clone throws (the run fails, visibly)", async () => {
  const { session } = fakeSession({ clone: { exitCode: 128, stdout: "fatal: repo not found" } });
  await expect(cloneCoderWorkspace(session, "tilsley/nope", "t", "run-3")).rejects.toThrow("clone");
});

// --- dispatch envelope ------------------------------------------------------

const config: AgentCoreDispatchConfig = { runtimeArn: "arn:aws:bedrock-agentcore:eu-west-2:1:runtime/x", region: "eu-west-2" };

test("agentcore dispatch carries the coder token in the invoke payload", async () => {
  const sent: any[] = [];
  const client = { send: async (cmd: any) => (sent.push(cmd.input), { statusCode: 202 }) } as any;
  const registry = { get: async () => ({ name: "c", kind: "coder" }) } as any;
  const run = { id: crypto.randomUUID(), status: "queued", task: "t", agent: "c", repo: "o/r", messages: [], createdAt: "", updatedAt: "" } as unknown as Run;
  agentCoreDispatch(config, { name: "m", update: async () => ({}) } as any, registry, undefined, client)(run, { githubToken: "ghs_x" });
  await new Promise((r) => setTimeout(r, 10));
  const payload = JSON.parse(new TextDecoder().decode(sent[0].payload));
  expect(payload).toEqual({ runId: run.id, githubToken: "ghs_x" });
});
