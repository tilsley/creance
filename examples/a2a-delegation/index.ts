#!/usr/bin/env bun
/**
 * Agent-to-agent (A2A) identity propagation demo (ADR-0017). When one agent calls
 * another, the call goes through the SAME gate, and the OBO delegation chain flows
 * with it: RFC 8693 nests the `act` claim, so at every hop the gate knows the HUMAN
 * (unchanged) and the full PATH of agents acting for them.
 *
 * Chain: alice  ──ticket-bot──▶  enrich-bot  ──▶  Jira
 *   - the human (alice) is the subject the whole way
 *   - each hop adds the calling agent to the chain (nested act)
 *   - each agent's gate authenticates the propagated identity + sees who called it
 *
 * Externals mocked: a NESTING token-exchange endpoint + a Jira that walks the chain.
 *
 *   bun run start
 */
import {
  runOnSession,
  httpRequestTool,
  OboTokenVaultBroker,
  MeshTrustAuthenticator,
  LocalSandboxProvider,
  NoopContentGuard,
  ConsoleTelemetrySink,
  type InferenceProvider,
  type Message,
  type AssistantTurn,
} from "@agent-os/core";

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

// --- NESTING token-exchange endpoint (RFC 8693): preserves the prior act chain ---
const idp = Bun.serve({
  port: 9301,
  async fetch(req) {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    const subj = claimsOf(String(form.subject_token));
    // new actor wraps the prior chain: act = { sub: thisAgent, act: <prior act> }
    const act = { sub: form.actor, ...(subj.act ? { act: subj.act } : {}) };
    // preserve the USER's identity claims (tenant/email/sub) — the exchange keeps WHO
    const access_token = jwt({ sub: subj.sub, tenant: subj.tenant, email: subj.email, aud: form.audience, act });
    return Response.json({ access_token, token_type: "Bearer", expires_in: 300 });
  },
});

// --- mock Jira: records the human (reporter) + the full delegation chain ---
const tickets: any[] = [];
const jira = Bun.serve({
  port: 9302,
  async fetch(req) {
    const c = claimsOf(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
    if (!c.sub || !c.act?.sub) return new Response(JSON.stringify({ error: "expected on-behalf-of token" }), { status: 401 });
    tickets.push({ key: `OPS-${tickets.length + 1}`, reporter: c.sub, chain: chainOf(c) });
    return Response.json(tickets[tickets.length - 1]);
  },
});

const EXCHANGE = "http://localhost:9301/token";
const gate = new MeshTrustAuthenticator(); // each agent's inbound gate

// each agent runs its OWN broker, identifying itself as the actor in the exchange
const ticketBotBroker = new OboTokenVaultBroker(
  JSON.stringify({ "enrich-bot": { tokenEndpoint: EXCHANGE, baseUrl: "http://enrich-bot", audience: "enrich-bot" } }),
  "ticket-bot",
);
const enrichBotBroker = new OboTokenVaultBroker(
  JSON.stringify({ jira: { tokenEndpoint: EXCHANGE, baseUrl: "http://localhost:9302", audience: "jira-api" } }),
  "enrich-bot",
);

class ScriptedBot implements InferenceProvider {
  readonly name = "scripted";
  readonly model = "scripted-a2a";
  async generate(messages: Message[]): Promise<AssistantTurn> {
    if (!messages.some((m) => m.role === "tool")) {
      const body = JSON.stringify({ fields: { project: "OPS", summary: "Enriched: export job failing" } });
      return { toolCalls: [{ id: "tc", name: "http_request", input: { target: "jira", path: "/rest/api/2/issue", method: "POST", body } }], usage: { inputTokens: 80, outputTokens: 20 } };
    }
    return { text: "ticket opened", toolCalls: [], usage: { inputTokens: 80, outputTokens: 20 } };
  }
}

// ---- HOP 0: the human's inbound token (no agents yet) ----
const aliceToken = jwt({ tenant: "support", sub: "alice@corp", email: "alice@corp" });
const aliceAtA = await gate.authenticate({ headers: { "x-agentos-identity": aliceToken } });
console.log(`\nalice ──▶ ticket-bot   gate: subject=${aliceAtA.subject} actors=[${(aliceAtA.actors ?? []).join(" → ")}]`);

// ---- HOP 1: ticket-bot (A) calls enrich-bot (B) → exchange adds ticket-bot ----
const tokenAB = (await ticketBotBroker.issue(aliceAtA, "enrich-bot"))!.token; // the credential ticket-bot presents to B
const aliceAtB = await gate.authenticate({ headers: { "x-agentos-identity": tokenAB } }); // B's gate authenticates the A2A call
console.log(`ticket-bot ──▶ enrich-bot   gate: subject=${aliceAtB.subject} actors=[${(aliceAtB.actors ?? []).join(" → ")}]   (B sees it's for alice, called by ticket-bot)`);

// ---- HOP 2: enrich-bot (B) runs and writes to Jira → exchange adds enrich-bot ----
const sandbox = new LocalSandboxProvider();
const session = await sandbox.startSession();
const transcript: Message[] = [];
try {
  const result = await runOnSession({
    inference: new ScriptedBot(),
    guard: new NoopContentGuard(),
    telemetry: new ConsoleTelemetrySink(),
    session,
    tools: () => [httpRequestTool(enrichBotBroker, aliceAtB)], // B acts with the propagated identity
    maxSteps: 4,
    systemPrompt: "You are enrich-bot. Open a Jira ticket via the 'jira' target.",
    task: "Open the enriched Jira ticket.",
    onProgress: (m) => {
      transcript.length = 0;
      transcript.push(...m);
    },
  });

  const t = tickets[0];
  console.log(`enrich-bot ──▶ Jira   ${result.output}`);
  console.log(`\n[result] Jira ticket ${t.key}: reporter='${t.reporter}'  delegation chain=[${t.chain.join(" → ")}]`);
  console.log(`[human preserved] subject is the human at every hop: ${t.reporter === "alice@corp" ? "yes ✅" : "no ❌"}`);
  console.log(`[chain accumulated] both agents recorded, most-recent first: ${JSON.stringify(t.chain) === JSON.stringify(["enrich-bot", "ticket-bot"]) ? "yes ✅" : "no ❌"}`);
  console.log(`[no leak] alice's original inbound token absent from B's transcript: ${(JSON.stringify(transcript) + result.output).includes(aliceToken) ? "LEAKED ❌" : "yes ✅"}`);
} finally {
  await session.close();
  idp.stop(true);
  jira.stop(true);
}
