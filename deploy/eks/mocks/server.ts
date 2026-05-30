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

// Mock OAuth 2.0 Token Exchange endpoint (RFC 8693) — the "token vault" / IdP that
// the OboTokenVaultBroker exchanges against (ADR-0016). Takes the caller's
// subject_token (the user's identity) + actor (the calling agent) and mints a
// downstream token that acts AS the user, recording the agent in a nested `act`
// claim — the OBO delegation chain. We decode the subject_token (JSON or JWT, no
// signature check — a real IdP verifies) and re-emit it with act:{sub:actor} on top,
// nesting any chain that was already there. The MeshTrustAuthenticator on the
// downstream agent decodes this same blob. NO real crypto — this models the exchange.
const decode = (v: string): any => {
  try {
    const p = v.split(".");
    const body = p.length === 3 ? Buffer.from(p[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : v;
    return JSON.parse(body);
  } catch {
    return {};
  }
};
Bun.serve({
  port: 9103, // mock token-exchange (the vault / IdP)
  async fetch(req) {
    if (req.headers.get("x-probe")) return new Response("ok"); // health
    const form = new URLSearchParams(await req.text());
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange")
      return new Response(JSON.stringify({ error: "unsupported_grant_type" }), { status: 400 });
    const subject = decode(form.get("subject_token") ?? "");
    if (!subject.tenant) return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
    const actor = form.get("actor") ?? "unknown-agent";
    // act AS the user, with the agent (and any prior chain) nested in `act` (RFC 8693 §4.1)
    const minted = {
      tenant: subject.tenant,
      email: subject.email ?? subject.sub,
      ...(subject.groups ? { groups: subject.groups } : {}),
      act: { sub: actor, ...(subject.act ? { act: subject.act } : {}) },
      aud: form.get("audience"),
    };
    return Response.json({
      access_token: JSON.stringify(minted), // a claims blob the downstream mesh-trust decodes
      issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_type: "Bearer",
      expires_in: 300,
    });
  },
});

console.log("mock slack :9101 · mock jira :9102 · mock token-exchange :9103");
