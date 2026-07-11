# claude-code-runner

Headless **Claude Code as a Fargate task-per-run** (ADR-0033). Agents registered with
`kind: "claude-code"` dispatch here instead of the L1 loop executor — same front door,
same gate, same runs table, same `GET /runs/{id}` polling; only the run body differs:
`claude -p <task>` executes inside this container with the harness owning think+do.

## Contract

- **In**: `RUN_ID` (ECS container override — identical to the loop executor's contract).
  The task text, agent name, and principal are read from the runs table.
- **Agent spec mapping**: `systemPrompt` → `--append-system-prompt`, `maxSteps` →
  `--max-turns` (default 30), `model` → `--model`.
- **Out**: stream-json events mirrored into the run's `messages` as they happen (the
  console poll reads a live transcript); terminal `status`/`output`/`usage`/`costUsd`
  from the final result event. Non-zero exit on failure so ECS surfaces it.

## Auth

The operator's Claude subscription: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)
injected by ECS from an SSM SecureString (default `aws/ssm` key — $0):

```sh
claude setup-token   # on your machine, prints a ~1-year token
aws ssm put-parameter --name /creance/claude-code/oauth-token \
  --type SecureString --value '<token>' --region eu-west-2
```

## Git via the egress sidecar (ADR-0034)

Name a `repo` ("owner/name") on the RUN — `POST /runs {"agent":"claude-code","repo":...}` —
to work on a real repo. The agent is repo-agnostic; whether a principal may target that repo
is authz's decision at the gate (`attributes.repo` — Rego under AUTHZ=opa, AllowAll in the
POC). The `egress-sidecar` container — the only holder of the git credential — proxies git
smart-HTTP on `localhost:8081`, allowlisted to the run's authorized repo, and only accepts
pushes creating/updating `refs/heads/run/*`. The shim clones through it onto `run/<id>` before
the harness starts and pushes + opens a PR after (even on a crashed run); the agent container
never holds a git credential.

**Git credential — GitHub App, per-run scoped tokens (the PAT is retired).** The sidecar holds
only the platform's GitHub **App private key** (one secret, `/creance/github-app-private-key`)
and at run start mints a fresh **installation token down-scoped to JUST the run's repo**
(contents + pull_requests write, ~1h TTL — `github-app-token.ts`). No long-lived credential
exists; nothing ever outreaches the single repo the gate authorized. Wire the App via env:
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID` (not secret), `GITHUB_APP_PRIVATE_KEY` (SSM). The
sidecar **fails closed** if the App is unconfigured or minting fails (e.g. App not installed on
the repo) — git is denied rather than falling back to anything broader.

```sh
# App private key — the one platform git secret, harness-agnostic (root path).
aws ssm put-parameter --name /creance/github-app-private-key \
  --type SecureString --value file:///path/to/app.private-key.pem --region eu-west-2
```

The App must be **installed on each repo** runs target (its installation token can only reach
installed repos). Verify a run minted (not failed) in the `claude-code-sidecar` log:
`minted GitHub App token for <owner>/<repo>`.

## Register the agent (PutItem, no redeploy — ADR-0031)

```sh
AWS_PROFILE=... bun run services/agent-runtime/agents-cli.ts \
  put '{"name":"claude-code","kind":"claude-code","maxSteps":30}'
```

## Guardrails

`--max-turns` per run, `CC_TIMEOUT_MS` hard kill (default 30 min — a hung harness burns
Fargate-seconds), `bypassPermissions` inside a non-root, throwaway container whose only
credentials are the runs/agents-table task role and the subscription token.

## Local

```sh
RUN_ID=<uuid> AWS_PROFILE=... bun run services/claude-code-runner/task.ts
```
