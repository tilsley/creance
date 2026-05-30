#!/usr/bin/env bun
/**
 * OBO (on-behalf-of) Token Vault demo — the act-AS-the-user counterpart to the
 * ticket-bot service-account demo (ADR-0010). Same agent + http_request tool; only
 * the CredentialBroker changes. Instead of the bot's own service-account token, the
 * OboTokenVaultBroker EXCHANGES the caller's inbound token (RFC 8693) for a
 * downstream token that acts AS the user — so the downstream system enforces the
 * USER's permissions and audits both identities.
 *
 * Externals are MOCKED: a token-exchange endpoint (stands in for AgentCore Identity /
 * Auth0 Token Vault) and a Jira that decodes the exchanged token. It demonstrates:
 *   1. the downstream sees the HUMAN (alice), not a service account — the OBO property
 *   2. the exchanged token carries BOTH identities (sub=user, act=agent)
 *   3. the vault CACHES per (user, target) — no re-exchange on the next call
 *   4. per-user scoping: bob gets a different downstream token
 *   5. the caller's token never enters the model's context (server-side)
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

// --- tiny unsigned-JWT helpers (the edge already verifies; we just carry claims) ---
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64u({ alg: "none" })}.${b64u(claims)}.sig`;
const claimsOf = (token: string): any => {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  } catch {
    return {};
  }
};

// --- mock token-exchange endpoint (the "vault" / IdP): RFC 8693 ---
let exchanges = 0;
const idp = Bun.serve({
  port: 9201,
  async fetch(req) {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    if (form.grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange")
      return new Response("unsupported_grant_type", { status: 400 });
    exchanges++;
    const user = claimsOf(String(form.subject_token)); // who the caller is
    // mint a downstream-scoped token that acts AS the user, carrying the agent as `act`
    const obo = jwt({ sub: user.sub ?? user.email, aud: form.audience, act: { sub: form.actor }, iss: "vault-mock" });
    return Response.json({ access_token: obo, issued_token_type: "urn:ietf:params:oauth:token-type:jwt", token_type: "Bearer", expires_in: 300 });
  },
});

// --- mock Jira: REQUIRES an on-behalf-of token (sub=user + act=agent) ---
const jiraTickets: any[] = [];
const jira = Bun.serve({
  port: 9202,
  async fetch(req) {
    const tok = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const c = claimsOf(tok);
    if (!c.sub || !c.act?.sub) return new Response(JSON.stringify({ error: "expected an on-behalf-of token" }), { status: 401 });
    let fields: any = {};
    try {
      fields = JSON.parse(await req.text()).fields ?? {};
    } catch {}
    const key = `OPS-${jiraTickets.length + 1}`;
    jiraTickets.push({ key, reporter: c.sub, actor: c.act.sub, summary: fields.summary }); // reporter = the USER
    return Response.json({ key, reporter: c.sub, actor: c.act.sub });
  },
});

// --- the OBO broker: exchange tokens for the 'jira' target; agent identity = ticket-bot ---
const broker = new OboTokenVaultBroker(
  JSON.stringify({ jira: { tokenEndpoint: "http://localhost:9201/token", baseUrl: "http://localhost:9202", audience: "jira-api" } }),
  "ticket-bot",
);

// --- scripted "model": open a Jira ticket (one http_request to the jira target) ---
class ScriptedBot implements InferenceProvider {
  readonly name = "scripted";
  readonly model = "scripted-obo";
  async generate(messages: Message[]): Promise<AssistantTurn> {
    const done = messages.some((m) => m.role === "tool");
    if (!done) {
      const body = JSON.stringify({ fields: { project: "OPS", summary: "Export job failing nightly" } });
      return { toolCalls: [{ id: "tc", name: "http_request", input: { target: "jira", path: "/rest/api/2/issue", method: "POST", body } }], usage: { inputTokens: 100, outputTokens: 20 } };
    }
    const created = (() => {
      try {
        const out = [...messages].reverse().find((m) => m.role === "tool")!.results[0]!.output;
        return JSON.parse(out.slice(out.indexOf("\n") + 1));
      } catch {
        return {};
      }
    })();
    return { text: `Opened ${created.key} (reporter: ${created.reporter}).`, toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 } };
  }
}

// --- inbound: the mesh edge forwards alice's verified token; authn surfaces it ---
const authn = new MeshTrustAuthenticator(); // header x-agentos-identity, subject from email/sub
const aliceToken = jwt({ tenant: "support", sub: "alice@corp", email: "alice@corp", groups: ["eng"] });
const alice = await authn.authenticate({ headers: { "x-agentos-identity": aliceToken } });
console.log(`\n[inbound] authn -> ${alice.tenant}/${alice.subject}  (carries subject_token for OBO)`);

const sandbox = new LocalSandboxProvider();
const session = await sandbox.startSession();
const transcript: Message[] = [];

try {
  const result = await runOnSession({
    inference: new ScriptedBot(),
    guard: new NoopContentGuard(),
    telemetry: new ConsoleTelemetrySink(),
    session,
    tools: () => [httpRequestTool(broker, alice)],
    maxSteps: 4,
    systemPrompt: "You are ticket-bot. Open a Jira ticket via the 'jira' target. The platform attaches credentials.",
    task: "Open a Jira ticket for the failing export job.",
    onProgress: (m) => {
      transcript.length = 0;
      transcript.push(...m);
    },
  });

  const t = jiraTickets[0];
  console.log(`[run] ${result.output}`);
  console.log(`\n[OBO] Jira sees: reporter='${t?.reporter}' (the HUMAN ✅, not a service account) · acting agent='${t?.actor}'`);
  console.log(`[OBO] exchanged token carries BOTH identities: sub=${t?.reporter} + act=${t?.actor} ✅`);

  // vault caching: a second issue for (alice, jira) reuses the cached token
  const before = exchanges;
  await broker.issue(alice, "jira");
  console.log(`\n[vault] re-issue for alice -> exchanges ${before} -> ${exchanges} (${exchanges === before ? "cached ✅" : "re-exchanged ❌"})`);

  // per-user scoping: bob gets a DIFFERENT downstream token (different sub)
  const bob = await authn.authenticate({ headers: { "x-agentos-identity": jwt({ tenant: "support", sub: "bob@corp", email: "bob@corp" }) } });
  const bobCred = await broker.issue(bob, "jira");
  console.log(`[per-user] bob's downstream token sub=${claimsOf(bobCred!.token).sub} (distinct from alice ✅)`);

  const leaked = (JSON.stringify(transcript) + result.output).includes(aliceToken);
  console.log(`\n[secrets] alice's inbound token in transcript: ${leaked ? "LEAKED ❌" : "absent ✅"}`);
} finally {
  await session.close();
  idp.stop(true);
  jira.stop(true);
}
