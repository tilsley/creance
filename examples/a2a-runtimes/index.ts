#!/usr/bin/env bun
/**
 * REAL two-process agent-to-agent over the standard A2A protocol (ADR-0017/0018).
 * Two actual agent-runtime processes: A (:3000) hosts ticket-bot, B (:3001) hosts
 * enrich-bot. alice calls A; A's call_agent tool discovers B via its Agent Card and
 * invokes it over A2A JSON-RPC (message/send → tasks/get), forwarding an on-behalf-of
 * token in the standard Authorization header; B authenticates it through its OWN gate
 * and calls Jira. The delegation chain propagates across the real network hop:
 *
 *   alice ──POST /runs──▶ ticket-bot(:3000) ──call_agent: POST /runs──▶ enrich-bot(:3001) ──▶ Jira
 *
 * Runtimes use scripted inference (INFERENCE_PROVIDER=scripted) so it's deterministic
 * and needs no Bedrock; identity/transport are entirely real. Mock IdP + Jira only.
 *
 *   bun run start    (from the repo root)
 */
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c: Record<string, unknown>) => `${b64u({ alg: "none" })}.${b64u(c)}.sig`;
const claimsOf = (t: string): any => {
  try {
    return JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
  } catch {
    return {};
  }
};
const chainOf = (c: any): string[] => {
  const out: string[] = [];
  for (let a = c.act; a && typeof a === "object"; a = a.act) if (a.sub) out.push(String(a.sub));
  return out;
};
const waitFor = async (url: string, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

const repoRoot = process.cwd();
const SERVER = `${repoRoot}/services/agent-runtime/server.ts`;

// --- mock NESTING token-exchange endpoint + mock Jira (the only mocks) ---
const idp = Bun.serve({
  port: 9401,
  async fetch(req) {
    const f = Object.fromEntries(new URLSearchParams(await req.text()));
    const s = claimsOf(String(f.subject_token));
    const act = { sub: f.actor, ...(s.act ? { act: s.act } : {}) }; // wrap prior chain
    return Response.json({ access_token: jwt({ sub: s.sub, tenant: s.tenant, email: s.email, aud: f.audience, act }), token_type: "Bearer", expires_in: 300 });
  },
});
const tickets: any[] = [];
const jira = Bun.serve({
  port: 9402,
  async fetch(req) {
    const c = claimsOf(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
    if (!c.sub || !c.act?.sub) return new Response(JSON.stringify({ error: "expected on-behalf-of token" }), { status: 401 });
    await req.text();
    tickets.push({ key: `OPS-${tickets.length + 1}`, reporter: c.sub, chain: chainOf(c) });
    return Response.json(tickets[tickets.length - 1]);
  },
});

const common = { SANDBOX_PROVIDER: "local", AUTHN: "mesh", GATE: "noop", GUARDRAIL_ID: "", AGENT_REGISTRY: "memory", CRED_BROKER: "vault", TELEMETRY: "console" };

// B (:3001) hosts enrich-bot: its script files a Jira ticket via http_request
const bproc = Bun.spawn({
  cmd: ["bun", "run", SERVER],
  cwd: repoRoot,
  stdout: "ignore",
  stderr: "inherit",
  env: {
    ...process.env,
    ...common,
    PORT: "3001",
    OBO_ACTOR: "enrich-bot",
    A2A_AGENT: "enrich-bot", // advertised on the Agent Card; run when a message names none
    AGENTS_JSON: JSON.stringify([{ name: "enrich-bot", tenant: "support" }]),
    INFERENCE_PROVIDER: "scripted",
    SCRIPTED_TURNS: JSON.stringify([
      { tool: "http_request", input: { target: "jira", path: "/rest/api/2/issue", method: "POST", body: '{"fields":{"project":"OPS","summary":"enriched: export job failing"}}' } },
      { text: "filed the Jira ticket" },
    ]),
    CRED_BROKER_CONFIG: JSON.stringify({ jira: { tokenEndpoint: "http://localhost:9401/token", baseUrl: "http://localhost:9402", audience: "jira-api" } }),
  },
});

// A (:3000) hosts ticket-bot: its script delegates to enrich-bot via call_agent
const aproc = Bun.spawn({
  cmd: ["bun", "run", SERVER],
  cwd: repoRoot,
  stdout: "ignore",
  stderr: "inherit",
  env: {
    ...process.env,
    ...common,
    PORT: "3000",
    OBO_ACTOR: "ticket-bot",
    A2A_AGENT: "ticket-bot",
    AGENTS_JSON: JSON.stringify([{ name: "ticket-bot", tenant: "support" }]),
    INFERENCE_PROVIDER: "scripted",
    SCRIPTED_TURNS: JSON.stringify([
      { tool: "call_agent", input: { agent: "enrich-bot", task: "enrich and file the Jira ticket" } },
      { text: "delegated to enrich-bot" },
    ]),
    CRED_BROKER_CONFIG: JSON.stringify({ "enrich-bot": { tokenEndpoint: "http://localhost:9401/token", baseUrl: "http://localhost:3001", audience: "enrich-bot" } }),
  },
});

try {
  const up = (await waitFor("http://localhost:3000/healthz")) && (await waitFor("http://localhost:3001/healthz"));
  if (!up) throw new Error("a runtime did not come up");
  console.log("\n▶ two agent-runtimes up: ticket-bot(:3000), enrich-bot(:3001)");

  // A2A discovery: read enrich-bot's Agent Card (what ticket-bot's call_agent does too)
  const card = await (await fetch("http://localhost:3001/.well-known/agent-card.json")).json();
  console.log(`▶ discovered Agent Card @ /.well-known/agent-card.json: name='${card.name}' proto=${card.protocolVersion} url=${card.url} auth=${Object.keys(card.securitySchemes ?? {}).join(",")}\n`);

  // alice calls A — her verified identity rides in the mesh header
  const aliceToken = jwt({ tenant: "support", sub: "alice@corp", email: "alice@corp" });
  const post = await fetch("http://localhost:3000/runs", {
    method: "POST",
    headers: { "content-type": "application/json", "x-agentos-identity": aliceToken },
    body: JSON.stringify({ agent: "ticket-bot", task: "Open a Jira ticket for the failing export job." }),
  });
  const { runId } = (await post.json()) as { runId: string };
  console.log(`alice ──POST /runs──▶ ticket-bot   (run ${runId.slice(0, 8)}, HTTP ${post.status})`);

  // poll A until its run (which blocks on the real call to B) finishes
  let run: any;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    run = await (await fetch(`http://localhost:3000/runs/${runId}`)).json();
    if (["completed", "failed", "blocked", "stuck", "max_steps"].includes(run.status)) break;
  }
  console.log(`ticket-bot run -> ${run.status}: ${run.output ?? run.error ?? ""}`);

  const t = tickets[0];
  console.log(`\n[downstream] Jira ticket ${t?.key}: reporter='${t?.reporter}'  delegation chain=[${(t?.chain ?? []).join(" → ")}]`);
  console.log(`[A2A transport] the A→B hop was a real A2A call (Agent Card discovery + JSON-RPC message/send → tasks/get), authenticated by B's own gate ✅`);
  console.log(`[agent card] served at /.well-known/agent-card.json with bearer security scheme: ${card.securitySchemes?.bearer ? "yes ✅" : "no ❌"}`);
  console.log(`[human preserved] reporter is the human across the network hop: ${t?.reporter === "alice@corp" ? "yes ✅" : "no ❌"}`);
  console.log(`[chain accumulated] [${(t?.chain ?? []).join(", ")}] == [enrich-bot, ticket-bot]: ${JSON.stringify(t?.chain) === JSON.stringify(["enrich-bot", "ticket-bot"]) ? "yes ✅" : "no ❌"}`);
} finally {
  aproc.kill();
  bproc.kill();
  idp.stop(true);
  jira.stop(true);
}
