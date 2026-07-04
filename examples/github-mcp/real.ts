#!/usr/bin/env bun
/**
 * A REAL MCP server through the broker (ADR-0010/0011) — not the mock.
 *
 * Points our `McpToolProvider` at GitHub's **remote** MCP server
 * (https://api.githubcopilot.com/mcp/) over HTTP, with the **CredentialBroker** injecting a
 * read-only PAT as `Authorization: Bearer` — the HTTP + broker credential path that had never
 * actually run (only a local stdio mock with no auth had). Proves three things:
 *
 *   1. capability — a GRANTED tenant gets real GitHub tools and real data (live issues);
 *   2. default-deny — an UNGRANTED tenant gets no GitHub tools (the broker is the gate);
 *   3. containment — the PAT never appears in the tool specs or output (injected server-side).
 *
 * The PAT lives ONLY in the broker grant (a static dev credential; prod mints short-lived ones —
 * CRED_BROKER=vault / a GitHub-App minter — so there is no static PAT at all). Read from env:
 *
 *   GITHUB_PAT="$(cat <pat-file>)" bun run examples/github-mcp/real.ts [owner] [repo]
 */
import { providersFromEnv, runOnSession, type ToolContext, type AgentTool } from "@agent-os/core";

const PAT = process.env.GITHUB_PAT?.trim();
if (!PAT) {
  console.error("set GITHUB_PAT (read-only PAT) — e.g. GITHUB_PAT=\"$(cat scratchpad/gh-pat)\" bun run ...");
  process.exit(1);
}
const owner = process.argv[2] ?? "modelcontextprotocol";
const repo = process.argv[3] ?? "servers";
// Least-privilege by default: the read-only endpoint exposes only read tools. (The base
// .../mcp/ endpoint lists ALL ~47 tools incl. create_branch/create_or_update_file — the PAT scope
// is then the only thing stopping a write; per-toolset/readonly URLs bound the capability instead.)
const endpoint = process.env.GITHUB_MCP_URL ?? "https://api.githubcopilot.com/mcp/readonly";

// the broker grants the `github` target to teamA ONLY (default-deny for everyone else).
process.env.CRED_BROKER = "local";
process.env.CRED_BROKER_CONFIG = JSON.stringify({
  teamA: { github: { scheme: "bearer", token: PAT, ttlSeconds: 300 } },
});
// GitHub's REMOTE MCP server over HTTP, open to all tenants (so the BROKER is the sole gate),
// credential injected server-side by the broker.
process.env.MCP_SERVERS = JSON.stringify({
  github: { transport: "http", url: endpoint, credentialTarget: "github" },
});
process.env.SANDBOX_PROVIDER = "local"; // a workspace session for the built-in tools (unused here)

const { toolProvider, sandbox, inference, guard, telemetry } = providersFromEnv();

const leak = (s: string) => s.includes(PAT); // the PAT must never surface to a caller/model

async function toolsFor(tenant: string): Promise<{ all: AgentTool[]; close: () => Promise<void>; closeSession: () => Promise<void> }> {
  const session = await sandbox.startSession();
  const ctx: ToolContext = { principal: { tenant, subject: "demo" }, session };
  const set = await toolProvider.resolve(ctx);
  return { all: set.tools, close: () => set.close(), closeSession: () => session.close() };
}

console.log(`▶ target repo: ${owner}/${repo}\n`);

// 1 + 2: policy — teamA (granted) sees github tools; teamB (not granted) does not.
const a = await toolsFor("teamA");
const aGithub = a.all.filter((t) => t.spec.name.startsWith("github__"));
console.log(`teamA  → ${a.all.length} tools, ${aGithub.length} from github (e.g. ${aGithub.slice(0, 6).map((t) => t.spec.name).join(", ")})`);

const b = await toolsFor("teamB");
const bGithub = b.all.filter((t) => t.spec.name.startsWith("github__"));
console.log(`teamB  → ${b.all.length} tools, ${bGithub.length} from github (broker default-deny)`);
await b.close(); await b.closeSession();

// 3: capability — call a real read tool and show live data.
const issuesTool = aGithub.find((t) => /list_issues|issues/i.test(t.spec.name));
console.log(`\n▶ calling ${issuesTool?.spec.name ?? "(none found)"} on ${owner}/${repo} …`);
let issuesOut = "";
if (issuesTool) {
  issuesOut = await issuesTool.run({ owner, repo, state: "open", perPage: 5 });
  const preview = issuesOut.replace(/\s+/g, " ").trim().slice(0, 600);
  console.log(`◀ ${preview}${issuesOut.length > 600 ? " …" : ""}`);
}
await a.close(); await a.closeSession();

// verdict
console.log(`\n──────── verdict ────────`);
let pass = 0;
aGithub.length > 0
  ? console.log(`✅ capability: granted tenant resolved ${aGithub.length} real github tools over HTTP`)
  : (console.log(`❌ no github tools for the granted tenant`), pass = 1);
bGithub.length === 0
  ? console.log(`✅ default-deny: ungranted tenant got 0 github tools (broker is the gate)`)
  : (console.log(`❌ ungranted tenant saw github tools`), pass = 1);
issuesTool && issuesOut && !/error/i.test(issuesOut.slice(0, 40))
  ? console.log(`✅ real data: live issues returned from ${owner}/${repo} through the broker-injected cred`)
  : (console.log(`❌ no live issue data returned`), pass = 1);
const specsLeak = aGithub.some((t) => leak(JSON.stringify(t.spec)));
!specsLeak && !leak(issuesOut)
  ? console.log(`✅ containment: the PAT never appears in tool specs or output (injected server-side)`)
  : (console.log(`❌ PAT leaked into a caller-visible surface`), pass = 1);
console.log(`─────────────────────────`);
console.log(pass === 0 ? `✅ Real MCP server proven through the broker — capability + default-deny + cred containment.` : `❌ FAILED — see above.`);

// Optional phase: a REAL agent (Bedrock) uses the read-only github tools to answer a live question.
//   WITH_AGENT=1 (+ AWS creds + MODEL_ID) bun run examples/github-mcp/real.ts
if (process.env.WITH_AGENT === "1") {
  console.log(`\n════════ agent (Bedrock) answers from the live repo ════════`);
  const session = await sandbox.startSession();
  const ctx: ToolContext = { principal: { tenant: "teamA", subject: "alice" }, session };
  const toolset = await toolProvider.resolve(ctx);
  try {
    const result = await runOnSession({
      inference,
      guard,
      telemetry,
      session,
      tools: () => toolset.tools,
      maxSteps: 6,
      systemPrompt:
        "You answer questions about GitHub repositories using your github__* tools (read-only). " +
        "Call the right tool with the owner and repo, then give a short factual answer and STOP.",
      task: `For the GitHub repo ${owner}/${repo}: how many OPEN issues are there right now, and what is the title of one of them? Answer in two short lines.`,
    });
    console.log(`\nstatus: ${result.status}`);
    console.log(`agent answer: ${result.output?.replace(/\s+/g, " ").trim().slice(0, 300)}`);
    if (result.output && leak(result.output)) { console.log("❌ PAT leaked into the agent answer"); pass = 1; }
    else console.log("✅ agent answered from live GitHub data via the broker-injected cred — PAT never in context");
  } finally {
    await toolset.close();
    await session.close();
  }
}
process.exit(pass);
