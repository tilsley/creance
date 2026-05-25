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
- `POST /runs` → body `{ "task": "..." }` → **`202`** `{ runId, status:"queued" }`
- `GET  /runs/{id}` → the `Run` `{ status, messages, output?, error? }`
  (`status`: `queued` | `running` | `completed` | `blocked` | `stuck` | `max_steps` | `failed`).
  The full step trace also goes to the `record` control (console or OTLP).

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
