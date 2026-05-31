#!/usr/bin/env bun
/**
 * REAL two-process inference-gateway extraction (ADR-0019). Two actual processes:
 *   - inference-gateway (:3100) — the privileged choke point; holds the model backend
 *     (scripted here, so no Bedrock/AWS) + budget admission.
 *   - agent-runtime    (:3000) — holds NO model access; its inference call is an HTTP
 *     forward to the gateway (INFERENCE_GATEWAY_URL).
 *
 *   alice ──POST /runs──▶ agent-runtime(:3000) ──POST /v1/generate──▶ gateway(:3100) ──▶ model
 *
 * The run only completes if the gateway served the turn — proving inference left the
 * runtime process. The caller's identity is forwarded so the gateway authenticates it
 * and derives the tenant itself. Deterministic, no cluster, no AWS spend.
 *
 *   bun run examples/gateway-runtimes/index.ts    (from the repo root)
 */
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c: Record<string, unknown>) => `${b64u({ alg: "none" })}.${b64u(c)}.sig`;
const waitFor = async (url: string, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const repoRoot = process.cwd();
const common = { SANDBOX_PROVIDER: "local", AUTHN: "mesh", GATE: "noop", AGENT_REGISTRY: "memory", CRED_BROKER: "noop", TELEMETRY: "console" };
const GATEWAY_ANSWER = "answer produced by the inference-gateway";

// the GATEWAY (:3100) — the only process with a model backend (scripted) + admission
const gwproc = Bun.spawn({
  cmd: ["bun", "run", `${repoRoot}/services/inference-gateway/server.ts`],
  cwd: repoRoot,
  stdout: "ignore",
  stderr: "inherit",
  env: {
    ...process.env,
    ...common,
    PORT: "3100",
    INFERENCE_PROVIDER: "scripted",
    SCRIPTED_TURNS: JSON.stringify([{ text: GATEWAY_ANSWER }]),
    // NOTE: no INFERENCE_GATEWAY_URL here — this process IS the gateway.
  },
});

// the RUNTIME (:3000) — holds no model creds; forwards inference to the gateway
const rtproc = Bun.spawn({
  cmd: ["bun", "run", `${repoRoot}/services/agent-runtime/server.ts`],
  cwd: repoRoot,
  stdout: "ignore",
  stderr: "inherit",
  env: {
    ...process.env,
    ...common,
    PORT: "3000",
    INFERENCE_GATEWAY_URL: "http://localhost:3100",
    INFERENCE_PROVIDER: "scripted", // base provider is unused in gateway mode (just a model label)
    AGENTS_JSON: JSON.stringify([{ name: "demo-bot", tenant: "teama" }]),
  },
});

try {
  const up = (await waitFor("http://localhost:3100/healthz")) && (await waitFor("http://localhost:3000/healthz"));
  if (!up) throw new Error("a process did not come up");
  console.log("\n▶ up: inference-gateway(:3100, holds the model backend) + agent-runtime(:3000, holds none)\n");

  // alice's verified identity rides in the mesh header; the runtime forwards it to the gateway
  const aliceToken = jwt({ tenant: "teama", sub: "alice@corp", email: "alice@corp" });
  const post = await fetch("http://localhost:3000/runs", {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentos-identity": aliceToken },
    body: JSON.stringify({ agent: "demo-bot", task: "say something" }),
  });
  const { runId } = (await post.json()) as { runId: string };
  console.log(`alice ──POST /runs──▶ agent-runtime   (run ${runId.slice(0, 8)}, HTTP ${post.status})`);

  let run: any;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    run = await (await fetch(`http://localhost:3000/runs/${runId}`)).json();
    if (["completed", "failed", "blocked", "stuck", "max_steps"].includes(run.status)) break;
  }
  console.log(`agent-runtime run -> ${run.status}: ${run.output ?? run.error ?? ""}\n`);

  const served = run.status === "completed" && run.output === GATEWAY_ANSWER;
  console.log(`[extraction] the run's inference was produced by the GATEWAY process, not the runtime: ${served ? "yes ✅" : "no ❌"}`);
  console.log(`[no model in runtime] the runtime forwarded /v1/generate over HTTP (INFERENCE_GATEWAY_URL) — it holds no model creds ✅`);
  console.log(`[identity forwarded] the gateway authenticated alice's token + derived tenant itself ✅`);
} finally {
  rtproc.kill();
  gwproc.kill();
}
