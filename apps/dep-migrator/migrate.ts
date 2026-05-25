#!/usr/bin/env bun
/**
 * dep-migrator (agent-os slice) — the first *real agent* built on @agent-os/core.
 *
 * A minimal slice of janey-ops' dep-migrator: get a repo into a workspace → bump
 * the target package → let the LLM investigate + apply breaking-change fixes via
 * the workspace tools → emit the diff. Deferred (vs the full agent): candidate
 * discovery, PR creation (#3), feedback/CI-fix turns, reflection/learnings,
 * event-sourcing. Uses Bedrock (not Copilot) + the local workspace (not E2B).
 *
 *   # built-in fixture (deterministic, $0):
 *   bun run start
 *   # a real public repo (cloned, no auth needed):
 *   REPO_URL=https://github.com/owner/repo PACKAGE=chalk TARGET_VERSION=5.3.0 bun run start
 */
import { providersFromEnv, runOnSession, workspaceTools, type SandboxSession } from "@agent-os/core";

// Clone needs network + git, so default the workspace to local (AgentCore SANDBOX
// mode is S3-only). Override with SANDBOX_PROVIDER=agentcore (+ PUBLIC network).
process.env.SANDBOX_PROVIDER ??= "local";

const REPO_URL = process.env.REPO_URL;
const PKG = process.env.PACKAGE ?? "lodash";
const TARGET = process.env.TARGET_VERSION ?? "4.17.21";

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * A tractable, self-verifying fixture: lodash v3 had `_.pluck`, REMOVED in v4
 * (use `_.map`). With v4 the program throws until the agent fixes it; running
 * `node src/index.js` is a clear pass/fail signal.
 */
async function seedFixture(session: SandboxSession): Promise<void> {
  await session.writeFile(
    "package.json",
    JSON.stringify(
      { name: "fixture", version: "1.0.0", type: "commonjs", dependencies: { lodash: "^3.10.1" } },
      null,
      2,
    ) + "\n",
  );
  await session.writeFile(
    "src/index.js",
    `const _ = require("lodash");\n` +
      `// _.pluck was REMOVED in lodash v4 — should become _.map(arr, "name").\n` +
      `const names = _.pluck([{ name: "ada" }, { name: "alan" }], "name");\n` +
      `if (names.join(",") !== "ada,alan") { console.error("FAIL", names); process.exit(1); }\n` +
      `console.log("OK", names.join(","));\n`,
  );
}

const { inference, guard, telemetry, sandbox } = providersFromEnv();
const session = await sandbox.startSession();
console.log(`workspace: ${session.id}  (sandbox=${sandbox.name})`);

try {
  // 1. get the repo into the workspace
  if (REPO_URL) {
    console.log(`cloning ${REPO_URL} …`);
    const c = await session.runCmd(`git clone --depth 1 ${q(REPO_URL)} .`);
    if (c.exitCode !== 0) throw new Error(`clone failed: ${c.stderr}`);
  } else {
    console.log(`seeding lodash fixture …`);
    await seedFixture(session);
    await session.runCmd("git init -q");
  }
  await session.runCmd("git add -A && git -c user.email=a@b.c -c user.name=dep-migrator commit -q -m baseline");

  // 2. bump the dependency version in package.json
  const pkgJson = JSON.parse(await session.readFile("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const target = `^${TARGET.replace(/^[^0-9]+/, "")}`;
  let bumped = false;
  for (const field of ["dependencies", "devDependencies"] as const) {
    if (pkgJson[field]?.[PKG]) {
      pkgJson[field]![PKG] = target;
      bumped = true;
    }
  }
  if (!bumped) throw new Error(`${PKG} not found in package.json dependencies`);
  await session.writeFile("package.json", JSON.stringify(pkgJson, null, 2) + "\n");
  console.log(`bumped ${PKG} → ${target}`);

  // 3. the LLM migrates, using the workspace tools
  const result = await runOnSession({
    inference,
    guard,
    telemetry,
    session,
    tools: workspaceTools,
    maxSteps: 25,
    systemPrompt:
      `You are a senior engineer applying a major-version npm upgrade. ${PKG} in package.json is already bumped to ${target}. ` +
      `Use your tools: list_files / read_file to find every file that uses ${PKG}, write_file to apply breaking-change fixes, run_cmd to install and VERIFY. ` +
      `VERIFY by actually running the program: run \`npm install\`, then \`node src/index.js\` and confirm it exits 0. Do NOT invent npm scripts (like "build") — read package.json first to see what exists. ` +
      `If a command fails the same way twice, do not repeat it — change approach. ` +
      `When the program runs successfully, reply with a one-paragraph summary of what you changed, and STOP — make no further tool calls.`,
    task: `Migrate ${PKG} to ${TARGET} in this repository and make \`node src/index.js\` pass.`,
  });

  // 4. emit the diff (the would-be PR contents)
  const diff = await session.runCmd("git diff HEAD");
  console.log("\n===== migration diff =====\n" + (diff.stdout.trim() || "(no changes)"));
  console.log(`\nstatus: ${result.status}`);
} finally {
  await session.close();
}
