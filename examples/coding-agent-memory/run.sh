#!/usr/bin/env bash
# Coding agent + files-first memory (ADR-0030) — proves memory PERSISTS across runs, as Markdown.
#   RUN 1: the agent learns durable project facts and saves them to MEMORY.md (the `remember` tool).
#   RUN 2: a FRESH session recalls them — WITHOUT being re-told — from its loaded Markdown memory.
# Both runs think through the governed inference gateway; memory lives in a durable host dir.
#   bash examples/coding-agent-memory/run.sh        (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:=nathan-tilsley-developer}"; export AWS_PROFILE AWS_REGION=eu-west-2 REGION=eu-west-2
HAIKU=eu.anthropic.claude-haiku-4-5-20251001-v1:0
MEMDIR="$ROOT/examples/coding-agent-memory/.memory"
rm -rf "$MEMDIR"  # start the demo from no memory
cleanup() { kill "${GW_PID:-}" 2>/dev/null; }
trap cleanup EXIT

echo "▶ boot the governed inference gateway (bob's claim \$5; spend → DynamoDB)"
GATE=local AUTHN=token GATE_TOKENS="tok-bob:bob:bob" \
  CLAIM_SOURCE=static CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}' \
  INFERENCE_PROVIDER=bedrock SPEND_STORE=dynamodb SPEND_TABLE=agent-os-budgets \
  MODEL_ID="$HAIKU" MODEL_ALIASES="{\"claude-haiku\":\"$HAIKU\"}" SANDBOX_PROVIDER=local PORT=4070 \
  bun run services/inference-gateway/server.ts > /tmp/cam-gw.log 2>&1 &
GW_PID=$!
curl -s --retry 90 --retry-delay 1 --retry-connrefused -o /dev/null http://localhost:4070/healthz 2>/dev/null

run_agent() { # $1 = task
  # MEMORY_RETRIEVAL=keyword (default, cheap) or =vector (full profile, Bedrock Titan embeddings).
  # The vector path also proves semantic recall: see examples/coding-agent-memory/compare-retrieval.ts.
  INFERENCE_GATEWAY_URL=http://localhost:4070 INFERENCE_GATEWAY_WIRE=bespoke \
    AGENT_TOKEN=tok-bob AGENT_TENANT=bob MODEL_ID=claude-haiku \
    SANDBOX_PROVIDER=local GATE=noop TELEMETRY=console AGENT_MEMORY_DIR="$MEMDIR" \
    MEMORY_RETRIEVAL="${MEMORY_RETRIEVAL:-keyword}" \
    bun run examples/coding-agent-memory/index.ts "$1"
}

echo; echo "════════ RUN 1 — learn + remember ════════"
run_agent "Remember these durable facts about this project for future sessions, saving EACH with the remember tool: (1) the test command is 'bun test'; (2) the architecture is the ports-and-adapters pattern; (3) the team prefers Bun over npm. Then confirm what you saved."

echo; echo "════════ MEMORY.md on disk (human-readable, the source of truth) ════════"
cat "$MEMDIR/bob/MEMORY.md" 2>/dev/null || echo "(no MEMORY.md written!)"

echo; echo "════════ RUN 2 — FRESH session, recall (the task does NOT restate the facts) ════════"
RUN2="$(run_agent "A new contributor asks two things: what command runs the tests, and what architecture pattern does this project use? Answer from your memory." 2>&1)"
echo "$RUN2"

echo; echo "──────── verdict (persistence) ────────"; pass=0
echo "$RUN2" | grep -qiE 'bun test'                 && echo "✅ recalled the test command (bun test) — from memory, not the prompt" || { echo "❌ did not recall 'bun test'"; pass=1; }
echo "$RUN2" | grep -qiE 'ports.?and.?adapters|ports-and-adapters' && echo "✅ recalled the architecture (ports-and-adapters) — from memory" || { echo "❌ did not recall the architecture"; pass=1; }
echo "─────────────────────────"
[ $pass -eq 0 ] && echo "✅ files-first memory proven — the agent remembered across a fresh session." || echo "❌ FAILED — see the runs above."

# RUN 3 — the SEMANTIC EDGE (why the vector/full profile exists), at the tool level on purpose:
# the agent preloads ALL of MEMORY.md into its system prompt, so at demo scale it answers any question
# from loaded memory and never needs memory_search — search quality only bites at scale (ADR-0023).
# So we isolate it where it's real: one no-shared-keyword query through both adapters' memory_search,
# live Bedrock Titan embeddings. Keyword MUST miss; vector MUST find it by meaning.
echo; echo "════════ RUN 3 — semantic recall: keyword MISSES, vector FINDS (live Titan) ════════"
bun run examples/coding-agent-memory/compare-retrieval.ts || { echo "❌ semantic-edge check FAILED — see above."; pass=1; }

echo; echo "──────── overall ────────"
[ $pass -eq 0 ] && echo "✅ memory proven end-to-end — persists across runs AND recalls by meaning." || echo "❌ FAILED — see the runs above."
exit $pass
