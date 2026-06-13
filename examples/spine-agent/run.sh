#!/usr/bin/env bash
# Run the spine agent against a live Bun inference gateway (ADR-0028; verified identity +
# budget → Bedrock). Boots the gateway with bob's claim ($5), runs the agent as bob, tears
# the gateway down. The claim names a friendly alias; the gateway's MODEL_ALIASES maps it to
# the Bedrock id (resolved on both wires — ADR-0028).
#   bash examples/spine-agent/run.sh ["your question"]      (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2 REGION=eu-west-2
HAIKU=eu.anthropic.claude-haiku-4-5-20251001-v1:0
cleanup() { kill "${GW_PID:-}" 2>/dev/null; }
trap cleanup EXIT

echo "▶ boot the Bun inference gateway (bob's claim \$5; spend → DynamoDB agent-os-budgets)"
GATE=local AUTHN=token GATE_TOKENS="tok-bob:bob:bob" \
  CLAIM_SOURCE=static CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}' \
  INFERENCE_PROVIDER=bedrock SPEND_STORE=dynamodb SPEND_TABLE=agent-os-budgets \
  MODEL_ID="$HAIKU" MODEL_ALIASES="{\"claude-haiku\":\"$HAIKU\"}" SANDBOX_PROVIDER=local PORT=4000 \
  bun run services/inference-gateway/server.ts > /tmp/spine-gw.log 2>&1 &
GW_PID=$!
curl -s --retry 90 --retry-delay 1 --retry-connrefused -o /dev/null http://localhost:4000/healthz 2>/dev/null

echo "▶ run the spine agent (holds no model creds; identity forwarded to the gateway)"
INFERENCE_GATEWAY_URL=http://localhost:4000 INFERENCE_GATEWAY_WIRE=bespoke MODEL_ID=claude-haiku \
  SANDBOX_PROVIDER=local GATE=noop TELEMETRY=console AGENT_TENANT=bob AGENT_TOKEN=tok-bob \
  bun run examples/spine-agent/index.ts "$@"
