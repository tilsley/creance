# agent-runtime

The **L1 agent loop as an HTTP service** — the "front door" from
[`docs/runtime.md`](../../docs/runtime.md). Same validated loop as the tracer
bullet, now invocable and deployable. Built entirely on
[`@agent-os/core`](../../packages/core); adapters chosen by env at boot.

## Endpoints
- `GET /healthz` → `{ "status": "ok" }`
- `POST /runs` → body `{ "task": "..." }` → `{ runId, status, output? }`
  (`status`: `completed` | `blocked` | `max_steps`). The full step trace goes to
  the `record` control (console or OTLP), not the HTTP body.

## Run
```bash
# fully local (no AWS): needs ollama + a tool-capable model (see tracer-bullet README)
INFERENCE_PROVIDER=ollama SANDBOX_PROVIDER=local PORT=3000 bun run start

# or against AWS (Bedrock + AgentCore): just creds + model access
PORT=3000 bun run start

curl localhost:3000/healthz
curl -s -X POST localhost:3000/runs -H 'content-type: application/json' \
  -d '{"task":"Use run_code to print 2+2."}'
```

## Config
Same ports/adapters seam as the rest (ADR-0003), via env: `INFERENCE_PROVIDER`,
`MODEL_ID`, `SANDBOX_PROVIDER`, `GUARDRAIL_ID`, `TELEMETRY`,
`OTEL_EXPORTER_OTLP_ENDPOINT`, `REGION`, `PORT`.

## Notes
- Trusted service → runs `runc`. **Language: TypeScript (Bun).**
- Providers are built once at boot and reused; each request gets its own sandbox
  session and trace.
- Next: containerize (Dockerfile) → deploy to k3s/EKS; declarative config via
  Crossplane.
