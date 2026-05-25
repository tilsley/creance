# agent-runtime

The **L1 runtime as an HTTP service** — the "front door" from
[`docs/runtime.md`](../../docs/runtime.md). Built entirely on
[`@agent-os/core`](../../packages/core); adapters chosen by env at boot.

**Runs are async + persisted.** A run is a first-class entity (the State
primitive — [`core/runs`](../../packages/core/src/runs.ts)): `POST /runs` returns
immediately with a `runId`, an in-process worker executes it, and you poll for the
result. State (conversation + status) is persisted to the `RunStore` each turn, so
a run is inspectable mid-flight. Why async: real agent runs are long-lived and
event-driven — a blocking request/response can't host them.

## Endpoints
- `GET  /healthz` → `{ "status": "ok" }`
- `POST /runs` → body `{ "task": "..." }` → **`202`** `{ runId, status:"queued", tenant }`
  Under `GATE=local`, requires `Authorization: Bearer <token>` (→ `401`); rejected
  with `402` if the tenant is over budget.
- `GET  /runs/{id}` → the `Run` `{ status, principal, messages, output?, usage, costUsd }`
  (`status`: `queued` | `running` | `completed` | `blocked` | `stuck` | `max_steps` | `failed`).
  The full step trace also goes to the `record` control (console or OTLP).
- `GET  /tenants/{tenant}/budget` → `{ limitUsd, spentUsd, remainingUsd, ok }`.

## Gate (identity + budget) — [ADR-0009](../../docs/decisions/0009-gate-identity-and-governance.md)
Default is **open** (`NoopGate`). Opt into auth + per-tenant budget with `GATE=local`:
```bash
GATE=local GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob" GATE_BUDGET_USD=1.00 \
  PORT=3000 bun run start

# 401 without a token; 202 with one; spend is costed from token usage per tenant
curl -s -X POST localhost:3000/runs -H 'authorization: Bearer tok-a' \
  -H 'content-type: application/json' -d '{"task":"Use run_code to print 2+2."}'
```
`LocalGate` is **dev only** (static tokens, in-memory spend). Swap-ins behind the
same port: AgentCore Identity / Auth0 Token Vault (human×agent token + downstream
creds), an AI gateway / Bedrock inference profiles + AWS Budgets (spend).

### Credential broker — [ADR-0010](../../docs/decisions/0010-credential-broker.md)
Runs get an `http_request` tool for **authenticated** outbound calls. The model
names a `target`; the `CredentialBroker` attaches that principal's scoped credential
**server-side — the secret never enters the model's context**. Default is deny-all;
grant per tenant with `CRED_BROKER=local`:
```bash
CRED_BROKER=local \
CRED_BROKER_CONFIG='{"teamA":{"github":{"scheme":"bearer","token":"...","baseUrl":"https://api.github.com","ttlSeconds":300}}}' \
  bun run start
```
See [`examples/credential-broker`](../../examples/credential-broker) for a runnable
demo that proves the secret never reaches the model.

### Tool/MCP gateway — [ADR-0011](../../docs/decisions/0011-tool-mcp-gateway.md)
Tools aren't hardcoded — each run's toolset is assembled by a `ToolProvider` from
built-in tools **plus configured MCP servers**, namespaced (`server__tool`) and
governed by a per-tenant allowlist. Add servers with `MCP_SERVERS`:
```bash
MCP_SERVERS='{"github":{"transport":"http","url":"https://api.githubcopilot.com/mcp/","tenants":["teamA"],"credentialTarget":"github"}}' \
  bun run start
```
`credentialTarget` pulls a scoped token from the broker into the server (env for
stdio, `Authorization` for HTTP). Hosted swap-in: AgentCore Gateway. See
[`examples/mcp-gateway`](../../examples/mcp-gateway) for a runnable demo.

## Run
```bash
# fully local (no AWS): needs ollama + a tool-capable model (see tracer-bullet README)
INFERENCE_PROVIDER=ollama SANDBOX_PROVIDER=local PORT=3000 bun run start

# or against AWS (Bedrock + AgentCore): just creds + model access
PORT=3000 bun run start

curl localhost:3000/healthz
ID=$(curl -s -X POST localhost:3000/runs -H 'content-type: application/json' \
  -d '{"task":"Use run_code to print 2+2."}' | bun -e 'console.log((await Bun.stdin.json()).runId)')
curl -s localhost:3000/runs/$ID          # poll until status is terminal
```

## Config
Same ports/adapters seam as the rest (ADR-0003), via env: `INFERENCE_PROVIDER`,
`MODEL_ID`, `SANDBOX_PROVIDER`, `GUARDRAIL_ID`, `TELEMETRY`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `REGION`, `PORT`.

## Notes
- Trusted service → runs `runc`. **Language: TypeScript (Bun).**
- Providers are built once at boot and reused; each run gets its own sandbox
  session and trace.
- **Durability today vs later:** `RunStore` is in-memory (a restart loses runs;
  fine for dev). Swap-in points, all behind ports: in-memory → **DynamoDB**;
  in-process fire-and-forget worker → **SQS + worker deployment** (durable queue +
  startup reconciliation of interrupted runs). Mid-run *resume* of in-flight work
  also needs durable workspace state — deferred.
- Next (#3, the `gate` control): authenticate `POST /runs`, attach
  tenant/principal to the run, scoped credentials + per-tenant budget.
