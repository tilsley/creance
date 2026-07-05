# @agent-os/console

The web console (ADR-0032): sign in with Cognito, launch governed runs against the
serverless front door (ADR-0031), and watch them turn by turn. A Vite + React SPA
with **no auth or AWS SDK dependencies** — login is a hand-rolled hosted-UI
authorization-code + PKCE flow (`src/auth.ts`, ~100 lines), and the id token it
yields is the same Bearer credential the gate verifies. Watching is polling: the
loop persists every turn, so a 1.5s poll of `GET /runs/{id}` reads like live.

## Views

- **Runs** — every run, status-chipped, cost in the ledger column (5s refresh).
- **New run** — task + agent picker (`GET /agents`); 402 from the gate surfaces as
  "budget exceeded".
- **Run detail** — the *turn ledger*: each persisted turn ruled off with the acting
  primitive stamped in the gutter (`task` / `think` / `do` / `done`), the live cost
  meter as the footer. Polling stops at a terminal status.
- **Budget** (rail) — the tenant's monthly spend against its cap (R2, always visible).

## Local dev

```bash
cp public/config.example.json public/config.json   # fill from the deployed stack outputs
bun install
bun run dev                                        # http://localhost:5173 (a registered callback URL)
```

`config.json` is runtime config, not a build-time bake — the deployed copy is
written by `ConsoleStack` from CDK outputs; the local copy is yours and gitignored.

## Deploy

```bash
bun run build                                      # ConsoleStack ships apps/console/dist
AWS_PROFILE=… bunx cdk deploy AgentOsConsole       # from infra/
```

First deploy only: register the printed `ConsoleUrl` as a hosted-UI callback —

```bash
bunx cdk deploy AgentOsAuth -c consoleCallbackUrls="https://<dist>.cloudfront.net/,http://localhost:5173/"
```
