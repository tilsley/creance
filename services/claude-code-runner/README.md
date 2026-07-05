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
aws ssm put-parameter --name /agent-os/claude-code/oauth-token \
  --type SecureString --value '<token>' --region eu-west-2
```

## Git via the egress sidecar (ADR-0034)

Name a `repo` ("owner/name") on the RUN — `POST /runs {"agent":"claude-code","repo":...}` —
to work on a real repo. The agent is repo-agnostic; whether a principal may target that repo
is authz's decision at the gate (`attributes.repo` — Rego under AUTHZ=opa, AllowAll in the
POC). The `egress-sidecar` container — the only holder of the GitHub PAT
(`/agent-os/claude-code/github-token`, SSM SecureString) — proxies git smart-HTTP on
`localhost:8081`, allowlisted to the run's authorized repo, and only accepts pushes
creating/updating `refs/heads/run/*`. The shim clones through it onto `run/<id>` before the
harness starts and pushes + opens a PR after (even on a crashed run); the agent container
never holds a git credential.

```sh
# fine-grained PAT: selected repos only, Contents read/write
aws ssm put-parameter --name /agent-os/claude-code/github-token \
  --type SecureString --value '<github_pat_...>' --region eu-west-2
```

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
