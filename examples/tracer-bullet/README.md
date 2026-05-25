# tracer-bullet

The thinnest runnable slice through agent-os: a ~120-line **agent loop** that
composes the two core *acting* primitives end to end —

- **think** → Amazon Bedrock (`Converse` API)
- **do** → AWS Bedrock **AgentCore Code Interpreter** (a Firecracker microVM per session)

The model gets one tool, `run_code`. When it calls it, the code runs in an
AgentCore session and the output is fed back. Loop until done. Proves the design's
riskiest assumptions (AgentCore is invocable from your machine; think→do composes;
cost/latency feel right) for fractions of a cent, with **no EKS / Crossplane / k3s**.

## Prerequisites

1. **Bun** installed.
2. **AWS creds** on your shell (default profile / env — same ones `aws sts get-caller-identity` uses).
3. **Region** — defaults to `eu-west-2` (AgentCore-supported).
4. **Bedrock model access** — an *active* model enabled in the Bedrock console →
   *Model access* (eu-west-2). Default is `amazon.nova-lite-v1:0`. ⚠ Legacy models
   (e.g. Claude 3 Haiku) are blocked by Bedrock unless used in the last 30 days —
   pick an ACTIVE model (`aws bedrock list-foundation-models ... modelLifecycle.status`).
5. **IAM** — your principal needs `bedrock:InvokeModel` and
   `bedrock-agentcore:StartCodeInterpreterSession` / `InvokeCodeInterpreter` /
   `StopCodeInterpreterSession`.

## Run

```bash
bun install
bun run start
```

Override via env (Bun auto-loads `.env`):

```bash
# better tool-calling than Nova Lite (needs Claude Haiku 4.5 model access enabled):
MODEL_ID=eu.anthropic.claude-haiku-4-5-20251001-v1:0 \
TASK="Sort these numbers and report the median: 8,3,9,1,5" \
bun run start
```

Find a model id you have access to:

```bash
aws bedrock list-inference-profiles --region eu-west-2   # needs a current AWS CLI
```

> Recent Claude models on Bedrock are invoked via a **cross-region inference
> profile id** (e.g. `eu.anthropic.claude-...`), not the bare model id.

## What success looks like

```
▶ region=eu-west-2  model=amazon.nova-lite-v1:0
▶ task: Compute the 25th Fibonacci number, then tell me whether it is prime. Use code.

✓ sandbox session: 01HX...
🧠 I'll compute it with code.
🛠  run_code:
    def fib(n): ...
📤 output:
    75025
    75025 is prime: False
🧠 The 25th Fibonacci number is 75025, which is not prime (75025 = 5^2 × 3001).

✅ done
✓ session stopped: 01HX...
```

## Structure (ports & adapters — ADR-0003)

```
ports.ts                        # Inference / Sandbox / ContentGuard / TelemetrySink — no SDK types
adapters/bedrock-inference.ts   # think  → Bedrock Converse
adapters/ollama-inference.ts    # think  → Ollama (local, free)
adapters/agentcore-sandbox.ts   # do     → AgentCore Code Interpreter
adapters/local-sandbox.ts       # do     → local python3 (DEMO ONLY — no isolation)
adapters/bedrock-guard.ts       # guard  → Bedrock Guardrails (ApplyGuardrail)
adapters/noop-guard.ts          # guard  → pass-through (default)
adapters/console-telemetry.ts   # record → console (default)
adapters/otel-telemetry.ts      # record → OpenTelemetry (console exporter / OTLP)
loop.ts                         # the L1 agent loop — imports ONLY ports.ts
index.ts                        # wires config → adapters → loop (the swap seam)
```

`loop.ts` has **zero AWS imports** — it can't tell Bedrock from Ollama or
AgentCore from a local sandbox. Swap by env: `INFERENCE_PROVIDER`,
`SANDBOX_PROVIDER` (only `bedrock` / `agentcore` implemented today; adding an
adapter = implementing the port). The same loop is what `inference-gateway` /
`sandbox-manager` will eventually drive.

## Swapping providers (the point of the ports)

Every primitive/control is chosen by env — `loop.ts` never changes:

| env | default | options |
|---|---|---|
| `INFERENCE_PROVIDER` | `bedrock` | `bedrock`, `ollama` |
| `SANDBOX_PROVIDER` | `agentcore` | `agentcore`, `local` |
| `GUARDRAIL_ID` | unset → `noop` | a Bedrock guardrail id |
| `TELEMETRY` | `console` | `console`, `otel` |

**Fully local — `$0`, no AWS, no IAM** (swap both `think` + `do`):
```bash
brew install ollama && ollama serve &
ollama pull llama3.1          # or qwen2.5 — must be a tool-capable model
INFERENCE_PROVIDER=ollama OLLAMA_MODEL=llama3.1 SANDBOX_PROVIDER=local \
  TASK="Use run_code to print the 25th Fibonacci number." bun run start
```

⚠ `SANDBOX_PROVIDER=local` runs model-generated code on your host with **no
isolation** — demo only. Production uses AgentCore (Firecracker) precisely to
avoid this; the point here is that swapping is a one-env-var change, loop untouched.

## Guard (content safety) — ADR-0008

`guard` is wired in but **off by default** (`NoopContentGuard`). The loop screens
two boundaries: the **input** task, and each **tool output** before it re-enters
model context (the injection defense). Turn it on with a Bedrock Guardrail:

```bash
# 1. add the guardrail IAM (already in iam-policy.json: ApplyGuardrail + create/get/list)
# 2. create a guardrail:
aws bedrock create-guardrail --region eu-west-2 \
  --name agent-os-poc \
  --blocked-input-messaging "Blocked by agent-os." \
  --blocked-outputs-messaging "Blocked by agent-os." \
  --content-policy-config '{"filtersConfig":[{"type":"PROMPT_ATTACK","inputStrength":"HIGH","outputStrength":"NONE"}]}' \
  --sensitive-information-policy-config '{"piiEntitiesConfig":[{"type":"EMAIL","action":"ANONYMIZE"}]}'
# 3. point the loop at it:
export GUARDRAIL_ID=<returned-id>  GUARDRAIL_VERSION=DRAFT
bun run start
```

Swap the implementation (Llama Guard, Presidio, LLM-as-judge…) by adding an
adapter behind `ContentGuard` — the loop never changes.

## Record (observability) — ADR-0003

Every step is wrapped in a span (`agent.run` → `guard.screen` / `inference.generate`
/ `sandbox.run_code`), tagged with token usage, guard verdicts, and durations.

- **Default** (`TELEMETRY=console`): structured `📊` lines — no deps, no infra.
- **`TELEMETRY=otel`**: real OpenTelemetry spans. With no endpoint → console span
  exporter; set `OTEL_EXPORTER_OTLP_ENDPOINT` to ship OTLP:
  ```bash
  docker run -d -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 TELEMETRY=otel bun run start
  # → trace waterfall at http://localhost:16686
  ```

OTel is itself the neutral layer (API = port, exporter = adapter). In production
the same code points OTLP at the in-cluster **ADOT collector → OpenSearch + S3** —
no app change, only the endpoint. The collector is infra, not app code
(see `infra/lib/data-log-stack.ts`).

## Maps to the model

`think` = Inference primitive · `do` = Sandbox primitive · `guard` + `record` =
controls. A hand-rolled L1 loop ([docs/runtime.md](../../docs/runtime.md)); `gate`
is the only building block not yet wired.
