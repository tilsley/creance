#!/usr/bin/env bun
/**
 * CredentialBroker demo (ADR-0010) — proves the security property that makes the
 * broker worth having: an agent acts on an authenticated API using a scoped
 * credential it NEVER sees.
 *
 * Setup: a local mock "API" that requires a bearer token. We grant teamA a
 * credential for it via LocalCredentialBroker, give the agent the http_request
 * tool, and ask it to call the API. Then we assert:
 *   1. the agent got the data (the tool authenticated server-side), and
 *   2. the secret never appears anywhere in the run transcript, and
 *   3. a different tenant (teamB) is denied (default-deny allowlist).
 *
 *   bun run start            (needs Bedrock creds + model access)
 */
import {
  providersFromEnv,
  runOnSession,
  workspaceTools,
  httpRequestTool,
  LocalCredentialBroker,
  type Message,
} from "@agent-os/core";

const SECRET = "sk-demo-" + crypto.randomUUID(); // the credential the model must never see
const PORT = 9099;

// 1. a mock downstream API that requires the bearer token
const api = Bun.serve({
  port: PORT,
  fetch(req) {
    const ok = req.headers.get("authorization") === `Bearer ${SECRET}`;
    if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return Response.json({ whoami: "demo-service", plan: "enterprise", seats: 42 });
  },
});

// 2. broker grants teamA a scoped, short-lived credential for "demo"; teamB gets nothing
const broker = new LocalCredentialBroker(
  JSON.stringify({
    teamA: { demo: { scheme: "bearer", token: SECRET, baseUrl: `http://localhost:${PORT}`, ttlSeconds: 120 } },
  }),
);

// default-deny check (no LLM needed)
const denied = await broker.issue({ tenant: "teamB", subject: "bob" }, "demo");
console.log(`teamB access to 'demo': ${denied === null ? "DENIED ✅ (default-deny)" : "GRANTED ❌"}`);

// 3. run the agent as teamA/alice with the authenticated tool
const { inference, guard, telemetry, sandbox } = providersFromEnv();
const principal = { tenant: "teamA", subject: "alice" };
const session = await sandbox.startSession();
const transcript: Message[] = [];

try {
  const result = await runOnSession({
    inference,
    guard,
    telemetry,
    session,
    tools: (s) => [...workspaceTools(s), httpRequestTool(broker, principal)],
    maxSteps: 6,
    systemPrompt:
      "You have an http_request tool for authenticated calls to allowlisted targets. " +
      "You never need credentials — the platform attaches them. Make the call, then report the result and STOP.",
    task: "Call the 'demo' target at path '/whoami' and tell me the 'plan' and 'seats' fields.",
    onProgress: (m) => {
      transcript.length = 0;
      transcript.push(...m);
    },
  });

  // the security assertion: the secret must not appear anywhere the model touched
  const blob = JSON.stringify(transcript) + (result.output ?? "");
  const leaked = blob.includes(SECRET);
  console.log(`\nstatus: ${result.status}`);
  console.log(`agent answer: ${result.output?.replace(/\s+/g, " ").trim().slice(0, 200)}`);
  console.log(`\nsecret in transcript: ${leaked ? "LEAKED ❌" : "absent ✅ (model never saw the credential)"}`);
} finally {
  await session.close();
  api.stop(true);
}
