#!/usr/bin/env bash
# Run the doc-gardener against a live LiteLLM gateway, on a throwaway fixture repo with
# deliberate docs drift (undocumented script + env var, stale path reference). Proves the
# whole chain locally: detectors → OpenCode session (think via the governed gateway,
# file-tool edits) → write allowlist → diff.
#   bash apps/doc-gardener/run.sh      (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2 REGION=eu-west-2
cleanup() { pkill -f "litellm --config" 2>/dev/null; }
trap cleanup EXIT

echo "▶ boot the inference gateway (bob's claim \$5; spend → DynamoDB agent-os-budgets)"
cd services/inference-gateway/litellm
BOB=$(uv run python -c "import warnings;warnings.filterwarnings('ignore');import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))" 2>/dev/null)
JWT_HS256_SECRET=testsecret CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}' \
  SPEND_STORE=dynamo SPEND_TABLE=agent-os-budgets \
  uv run litellm --config config.yaml --port 4000 --num_workers 1 > /tmp/doc-gardener-gw.log 2>&1 &
cd "$ROOT"
curl -s --retry 90 --retry-delay 1 --retry-connrefused -o /dev/null http://localhost:4000/health/readiness 2>/dev/null

echo "▶ run the doc-gardener on the drifted fixture (think → gateway → Bedrock; edits → allowlisted docs)"
INFERENCE_GATEWAY_URL=http://localhost:4000 MODEL_ID=claude-haiku \
  AGENT_TENANT=bob AGENT_TOKEN="$BOB" FIXTURE_DIR="$ROOT/apps/doc-gardener/fixture" \
  bun run apps/doc-gardener/index.ts
