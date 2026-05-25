# dep-migrator (agent-os slice)

The first **real agent** on `@agent-os/core` — a minimal port of janey-ops'
dep-migrator. Given a repo + a package + a target version, it migrates the major
upgrade and prints the diff.

Loop: get repo into a **workspace** → bump the version → the **LLM** investigates
and edits via workspace tools (`list_files` / `read_file` / `write_file` /
`run_cmd`) → emit the **diff**. Built entirely on the platform — `providersFromEnv`
+ `runOnSession` + `workspaceTools`.

## Run
```bash
# built-in fixture — deterministic, $0 (local workspace + Bedrock):
bun run start

# a real PUBLIC repo (cloned via the local workspace — no GitHub auth needed):
REPO_URL=https://github.com/owner/repo PACKAGE=chalk TARGET_VERSION=5.3.0 bun run start
```
Env: `PACKAGE`, `TARGET_VERSION`, `REPO_URL` (optional), plus the usual
`@agent-os/core` knobs (`MODEL_ID`, `GUARDRAIL_ID`, `TELEMETRY`, …). Defaults to
`SANDBOX_PROVIDER=local` because `git clone` needs network+git (AgentCore `SANDBOX`
mode is S3-only).

> A bigger/sharper model (`MODEL_ID=eu.anthropic.claude-haiku-4-5-...`) does
> markedly better at multi-step migration than Nova Lite.

## Scope vs the real dep-migrator
**This slice:** clone/seed → bump → LLM migrate → diff.
**Deferred:** candidate discovery (npm scan), **PR creation (#3 — GitHub token +
credential broker)**, feedback/CI-fix turns, reflection/learnings, event-sourcing.
**Swapped:** Bedrock (not Copilot SDK), local workspace (not E2B).

## What it proves
That a real agent — clone a repo, reason over it, edit files, run commands —
runs on `@agent-os/core` with the building blocks behind ports: `think` (Bedrock),
`do` (the workspace Sandbox), `guard`, `record`. Next: #3 adds the GitHub
credential broker + opens an actual PR, against your own repos.
