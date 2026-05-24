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

## Where this maps

`think` = the Inference primitive (`inference-gateway` will wrap this);
`do` = the Sandbox primitive (`sandbox-manager` will own session lifecycle). This
is a hand-rolled L1 loop ([docs/runtime.md](../../docs/runtime.md)) — no gate /
record / guard controls yet; those come next.
