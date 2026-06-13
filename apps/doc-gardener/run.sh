#!/usr/bin/env bash
# Run the doc-gardener against a live Bun inference gateway (ADR-0028), on a throwaway fixture
# repo with deliberate docs drift (undocumented script + env var, stale path reference). Proves
# the whole chain locally: detectors → OpenCode session (think via the governed gateway on the
# Anthropic /v1/messages wire, file-tool edits) → write allowlist → diff. The claim names the
# real Bedrock id — on /v1/messages the claim's model wins and is handed to Bedrock verbatim.
#   bash apps/doc-gardener/run.sh      (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2 REGION=eu-west-2
HAIKU=eu.anthropic.claude-haiku-4-5-20251001-v1:0
cleanup() { kill "${GW_PID:-}" 2>/dev/null; }
trap cleanup EXIT

echo "▶ boot the Bun inference gateway (bob's claim \$5; spend → DynamoDB agent-os-budgets)"
GATE=local AUTHN=token GATE_TOKENS="tok-bob:bob:bob" \
  CLAIM_SOURCE=static CLAIMS_STATIC="{\"bob\":{\"model\":\"$HAIKU\",\"monthlyBudgetUsd\":5}}" \
  INFERENCE_PROVIDER=bedrock SPEND_STORE=dynamodb SPEND_TABLE=agent-os-budgets \
  MODEL_ID="$HAIKU" SANDBOX_PROVIDER=local PORT=4000 \
  bun run services/inference-gateway/server.ts > /tmp/doc-gardener-gw.log 2>&1 &
GW_PID=$!
curl -s --retry 90 --retry-delay 1 --retry-connrefused -o /dev/null http://localhost:4000/healthz 2>/dev/null

echo "▶ run the doc-gardener on the drifted fixture (think → gateway → Bedrock; edits → allowlisted docs)"
INFERENCE_GATEWAY_URL=http://localhost:4000 MODEL_ID=claude-haiku \
  AGENT_TENANT=bob AGENT_TOKEN=tok-bob FIXTURE_DIR="$ROOT/apps/doc-gardener/fixture" \
  bun run apps/doc-gardener/index.ts
