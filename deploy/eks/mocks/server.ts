#!/usr/bin/env bun
/**
 * Mock Slack + mock Jira for the EKS field trip (one process, two ports). Each
 * requires the bot's SERVICE-ACCOUNT bearer token (proving the CredentialBroker
 * injected it server-side) — that's the auth point we're testing. Tokens come from
 * env so the runtime's broker config and these mocks share the same secret.
 *
 *   SLACK on :9101  ·  JIRA on :9102
 */
const SLACK_SA = process.env.SLACK_SA ?? "slack-sa-token";
const JIRA_SA = process.env.JIRA_SA ?? "jira-sa-token";

const THREAD = [
  { user: "alice", text: "the nightly export job has failed 3 nights running — customers can't download reports" },
  { user: "bob", text: "looks tied to the S3 lifecycle change; we should track this" },
  { user: "alice", text: "can someone open a ticket?" },
];

const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

Bun.serve({
  port: 9101, // mock Slack
  fetch(req) {
    if (req.headers.get("x-probe")) return new Response("ok"); // health
    if (bearer(req) !== SLACK_SA) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    return Response.json(THREAD);
  },
});

const jiraTickets: any[] = [];
Bun.serve({
  port: 9102, // mock Jira
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/_tickets") return Response.json(jiraTickets); // inspection endpoint for the test
    if (req.headers.get("x-probe")) return new Response("ok"); // health
    if (bearer(req) !== JIRA_SA) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    let fields: any = {};
    try {
      fields = JSON.parse(await req.text()).fields ?? {};
    } catch {}
    const key = `OPS-${jiraTickets.length + 1}`;
    jiraTickets.push({ key, summary: fields.summary, description: fields.description });
    return Response.json({ key, self: `/rest/api/2/issue/${key}` });
  },
});

console.log("mock slack :9101 · mock jira :9102 (service-account auth required)");
