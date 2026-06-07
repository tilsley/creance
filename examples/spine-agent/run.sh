#!/usr/bin/env bash
# Run the spine agent against a live LiteLLM gateway (verified identity + budget → Bedrock).
# Boots the gateway with bob's claim ($5), runs the agent as bob, tears the gateway down.
#   bash examples/spine-agent/run.sh ["your question"]      (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2 REGION=eu-west-2
cleanup() { pkill -f "litellm --config" 2>/dev/null; }
trap cleanup EXIT

echo "▶ boot the inference gateway (bob's claim \$5; spend → DynamoDB agent-os-budgets)"
cd services/inference-gateway/litellm
BOB=$(uv run python -c "import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))")
JWT_HS256_SECRET=testsecret CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}' \
  SPEND_STORE=dynamo SPEND_TABLE=agent-os-budgets \
  uv run litellm --config config.yaml --port 4000 --num_workers 1 > /tmp/spine-gw.log 2>&1 &
cd "$ROOT"
curl -s --retry 90 --retry-delay 1 --retry-connrefused -o /dev/null http://localhost:4000/health/readiness 2>/dev/null

echo "▶ run the spine agent (holds no model creds; identity forwarded to the gateway)"
INFERENCE_GATEWAY_URL=http://localhost:4000 INFERENCE_GATEWAY_WIRE=openai MODEL_ID=claude-haiku \
  SANDBOX_PROVIDER=local GATE=noop TELEMETRY=console AGENT_TENANT=bob AGENT_TOKEN="$BOB" \
  bun run examples/spine-agent/index.ts "$@"
