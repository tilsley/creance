#!/usr/bin/env bun
/**
 * ticket-bot demo — a useful end-to-end flow on the real seams (ADR-0010/0015):
 * a Slack request -> read the thread -> open a Jira ticket. Slack and Jira are
 * MOCKED (local HTTP servers requiring a bearer token); everything else is the
 * real machinery.
 *
 * What it demonstrates:
 *   1. Inbound gate (ADR-0015): authenticate the caller to a Principal, authorize
 *      the action. (StaticToken authn + AllowAll authz here; swap MeshTrust + OPA.)
 *   2. Per-target SERVICE ACCOUNTS (ADR-0010): the broker grants the `support`
 *      tenant two *different* credentials — `slack` (read) and `jira` (write) —
 *      each its own service account, the "few SAs with different perms" model.
 *   3. Server-side credential injection: the SA tokens are attached inside the
 *      http_request tool and NEVER enter the model's context.
 *   4. Attribution vs authorization: the ticket records the *human* who asked
 *      (alice@corp) as requester, while the *bot's service account* is what Jira
 *      authorized. (The act-on-behalf-of / OBO model — using alice's own Jira
 *      permissions — would be the CredentialBroker's Token-Vault swap-in instead.)
 *   5. Default-deny: a different tenant reaches neither target.
 *
 * Inference is SCRIPTED (below) so the demo is self-contained + deterministic and
 * focuses on the identity/credential path. Swap in `providersFromEnv().inference`
 * for a real LLM driving the same tools.
 *
 *   bun run start
 */
import {
  runOnSession,
  httpRequestTool,
  LocalCredentialBroker,
  LocalSandboxProvider,
  NoopContentGuard,
  ConsoleTelemetrySink,
  StaticTokenAuthenticator,
  AllowAllAuthorizer,
  type InferenceProvider,
  type Message,
  type AssistantTurn,
} from "@agent-os/core";

// --- mock externals: each requires its own bearer token (a service account) ---
const SLACK_SA = "slack-sa-" + crypto.randomUUID();
const JIRA_SA = "jira-sa-" + crypto.randomUUID();

const THREAD = [
  { user: "alice", text: "the nightly export job has failed 3 nights running — customers can't download reports" },
  { user: "bob", text: "looks tied to the S3 lifecycle change. we should track this properly" },
  { user: "alice", text: "can someone open a ticket?" },
];

const slack = Bun.serve({
  port: 9101,
  fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${SLACK_SA}`)
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return Response.json(THREAD); // the conversation
  },
});

const jiraTickets: any[] = [];
const jira = Bun.serve({
  port: 9102,
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${JIRA_SA}`)
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    let fields: any = {};
    try {
      fields = JSON.parse(await req.text()).fields ?? {};
    } catch {}
    const key = `OPS-${jiraTickets.length + 1}`;
    jiraTickets.push({ key, ...fields });
    return Response.json({ key, self: `http://localhost:9102/rest/api/2/issue/${key}` });
  },
});

// --- the broker: two service accounts for the `support` tenant; default-deny else ---
const broker = new LocalCredentialBroker(
  JSON.stringify({
    support: {
      slack: { scheme: "bearer", token: SLACK_SA, baseUrl: "http://localhost:9101", ttlSeconds: 300 },
      jira: { scheme: "bearer", token: JIRA_SA, baseUrl: "http://localhost:9102", ttlSeconds: 300 },
    },
  }),
);

// --- scripted "model": read slack -> create jira -> report (drives the real loop) ---
const httpBody = (out: string) => {
  try {
    return JSON.parse(out.slice(out.indexOf("\n") + 1));
  } catch {
    return undefined;
  }
};
const lastToolOutput = (messages: Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") return m.results[0]?.output ?? "";
  }
  return "";
};

class ScriptedTicketBot implements InferenceProvider {
  readonly name = "scripted";
  readonly model = "scripted-ticket-bot";
  constructor(private readonly requester: string) {}

  async generate(messages: Message[], _tools: unknown, _opts: unknown): Promise<AssistantTurn> {
    const step = messages.filter((m) => m.role === "tool").length;
    const usage = { inputTokens: 200, outputTokens: 40 };

    if (step === 0) {
      // 1. read the Slack thread (target=slack -> broker injects the slack SA)
      return {
        toolCalls: [{ id: "tc-slack", name: "http_request", input: { target: "slack", path: "/thread", method: "GET" } }],
        usage,
      };
    }
    if (step === 1) {
      // 2. summarize the thread + open a Jira ticket (target=jira -> the jira SA)
      const thread = httpBody(lastToolOutput(messages)) as Array<{ user: string; text: string }> | undefined;
      const summary = (thread?.[0]?.text ?? "Issue from Slack").slice(0, 70);
      const description =
        "Raised from a Slack thread:\n" +
        (thread ?? []).map((m) => `- ${m.user}: ${m.text}`).join("\n") +
        `\n\nRequested by ${this.requester} via Slack.`; // <-- attribution: the human who asked
      const body = JSON.stringify({ fields: { project: "OPS", issuetype: "Bug", summary, description } });
      return {
        toolCalls: [
          { id: "tc-jira", name: "http_request", input: { target: "jira", path: "/rest/api/2/issue", method: "POST", body } },
        ],
        usage,
      };
    }
    // 3. report the created ticket
    const created = httpBody(lastToolOutput(messages)) as { key?: string } | undefined;
    return { text: `Done — opened Jira ticket ${created?.key ?? "(unknown)"} from the Slack thread.`, toolCalls: [], usage };
  }
}

// --- inbound gate (ADR-0015): authenticate the Slack caller, authorize the action ---
const authn = new StaticTokenAuthenticator("slack-ingress-tok:support:alice@corp");
const authz = new AllowAllAuthorizer();
const principal = await authn.authenticate({ credential: "slack-ingress-tok", headers: {} });
const decision = await authz.authorize(principal, "run:create", "ticket-bot");

console.log(`\n[inbound gate] authn(${authn.name}) -> ${principal.tenant}/${principal.subject}` +
  ` · authz(${authz.name}) -> ${decision.allow ? "allow ✅" : "deny ❌"}`);
if (!decision.allow) process.exit(1);

// --- run ticket-bot as the authenticated principal ---
const sandbox = new LocalSandboxProvider();
const session = await sandbox.startSession();
const transcript: Message[] = [];

try {
  const result = await runOnSession({
    inference: new ScriptedTicketBot(principal.subject),
    guard: new NoopContentGuard(),
    telemetry: new ConsoleTelemetrySink(),
    session,
    tools: () => [httpRequestTool(broker, principal)],
    maxSteps: 6,
    systemPrompt:
      "You are ticket-bot. Read the Slack thread via the 'slack' target, then open a Jira ticket via the 'jira' " +
      "target summarising the issue. The platform attaches credentials — you never see or handle them.",
    task: `Slack request from ${principal.subject}: please open a Jira ticket from the thread.`,
    onProgress: (m) => {
      transcript.length = 0;
      transcript.push(...m);
    },
  });

  const t = jiraTickets[0];
  const blob = JSON.stringify(transcript) + (result.output ?? "");
  console.log(`\n[run] status=${result.status}`);
  console.log(`[run] agent: ${result.output?.replace(/\s+/g, " ").trim()}`);
  console.log(`\n[jira] tickets created: ${jiraTickets.length}  -> ${t?.key}: "${t?.summary}"`);
  console.log(`[attribution] ticket records requester '${principal.subject}': ` +
    `${String(t?.description).includes(principal.subject) ? "yes ✅ (human = attribution)" : "no ❌"}` +
    `  | authorized by: the bot's jira service account`);
  console.log(`\n[secrets] slack SA in transcript: ${blob.includes(SLACK_SA) ? "LEAKED ❌" : "absent ✅"}` +
    `  · jira SA in transcript: ${blob.includes(JIRA_SA) ? "LEAKED ❌" : "absent ✅"}`);

  const denied = await broker.issue({ tenant: "marketing", subject: "eve" }, "jira");
  console.log(`[default-deny] tenant 'marketing' -> jira: ${denied === null ? "DENIED ✅" : "GRANTED ❌"}`);
} finally {
  await session.close();
  slack.stop(true);
  jira.stop(true);
}
