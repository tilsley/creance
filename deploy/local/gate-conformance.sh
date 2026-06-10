#!/usr/bin/env bash
# Gate conformance suite (ADR-0027, extended by ADR-0028): the load-bearing gate contract
# must hold IDENTICALLY across BOTH gateway impls, so the two never drift on R1 (identity)
# + R2 (budget) — it is also ADR-0028's migration gate (LiteLLM must keep passing until the
# Bun gateway covers everything the deploy path uses):
#   - Bun bespoke `/v1/generate`            — cheap mode (static token + LocalGate, in-memory)
#   - LiteLLM OpenAI `/v1/chat/completions` — full mode (JWT custom_auth + claim budget)
#   - Anthropic `/v1/messages` on BOTH      — the agent-client wire (Claude Code / OpenCode)
# Each asserted case REJECTS before any model call ⇒ $0, no AWS. Same outcome, two dialects.
#   bash deploy/local/gate-conformance.sh        (from the repo root)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
BUN_PORT=3201; LITE_PORT=3202
cleanup() { kill "${BUN_PID:-}" "${LITE_PID:-}" 2>/dev/null; pkill -f "litellm --config" 2>/dev/null; }
trap cleanup EXIT

echo "▶ start Bun gateway (cheap mode: static token + local gate + static claims, scripted model, no AWS)"
GATE=local AUTHN=token GATE_TOKENS="tok-bob:bob:bob,tok-carol:carol:carol" GATE_BUDGET_USD=0.0001 \
  CLAIM_SOURCE=static CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":0.0001}}' \
  INFERENCE_PROVIDER=scripted SCRIPTED_TURNS='[]' SANDBOX_PROVIDER=local PORT=$BUN_PORT \
  bun run services/inference-gateway/server.ts > /tmp/conf-bun.log 2>&1 &
BUN_PID=$!

echo "▶ start LiteLLM gateway (full mode: JWT custom_auth + claim budget)"
cd services/inference-gateway/litellm
BOB=$(uv run python -c "import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))")
CAROL=$(uv run python -c "import jwt;print(jwt.encode({'sub':'carol'},'testsecret',algorithm='HS256'))")
JWT_HS256_SECRET=testsecret CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":0.0001}}' \
  SPEND_STORE=dynamo REGION=eu-west-2 AWS_REGION=eu-west-2 \
  uv run litellm --config config.yaml --port $LITE_PORT --num_workers 1 > /tmp/conf-lite.log 2>&1 &
LITE_PID=$!
cd "$ROOT"

curl -s --retry 60 --retry-delay 1 --retry-connrefused -o /dev/null "http://localhost:$BUN_PORT/healthz" 2>/dev/null
curl -s --retry 90 --retry-delay 1 --retry-connrefused -o /dev/null "http://localhost:$LITE_PORT/health/readiness" 2>/dev/null

# drivers — send a case to each gateway in ITS dialect, return the HTTP status
code() { # $1=base-url+path  $2=auth-value-or-empty  $3=body
  if [ -n "$2" ]; then
    curl -s -m 8 -o /dev/null -w '%{http_code}' "$1" -H 'content-type: application/json' -H "authorization: $2" -d "$3" 2>/dev/null || echo 000
  else
    curl -s -m 8 -o /dev/null -w '%{http_code}' "$1" -H 'content-type: application/json' -d "$3" 2>/dev/null || echo 000
  fi
}
BUN="http://localhost:$BUN_PORT/v1/generate"
LITE="http://localhost:$LITE_PORT/v1/chat/completions"
bun_code() { code "$BUN" "$1" "$2"; }    # bespoke wire
lite_code() { code "$LITE" "$1" "$2"; }  # openai wire
B_OK='{"messages":[{"role":"user","text":"hi"}],"maxTokens":200}'
B_NOMAX='{"messages":[{"role":"user","text":"hi"}]}'
L_OK='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200}'
L_NOMAX='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}]}'

pass=0; fail=0
check() { # $1=desc $2=expected $3=bun $4=lite
  if [ "$3" = "$2" ] && [ "$4" = "$2" ]; then printf "  ✅ %-34s both → %s\n" "$1" "$2"; pass=$((pass+1));
  else printf "  ❌ %-34s expected %s; bun=%s lite=%s\n" "$1" "$2" "$3" "$4"; fail=$((fail+1)); fi
}

echo "▶ THE CONTRACT — must be identical on both gateways (R1 + R2):"
check "no credential → 401"          401 "$(bun_code '' "$B_OK")"             "$(lite_code '' "$L_OK")"
check "bad credential → 401"         401 "$(bun_code 'Bearer nope' "$B_OK")"  "$(lite_code 'Bearer nope' "$L_OK")"
check "valid id, no maxTokens → 400" 400 "$(bun_code 'Bearer tok-bob' "$B_NOMAX")" "$(lite_code "Bearer $BOB" "$L_NOMAX")"
check "worst-case > budget → 402"    402 "$(bun_code 'Bearer tok-bob' "$B_OK")"    "$(lite_code "Bearer $BOB" "$L_OK")"

echo "▶ THE ANTHROPIC WIRE (ADR-0028) — /v1/messages on BOTH gateways, the agent-client wire:"
BUN_A="http://localhost:$BUN_PORT/v1/messages"
LITE_A="http://localhost:$LITE_PORT/v1/messages"
akey() { # x-api-key variant (the Anthropic SDKs' native header): $1=url $2=key $3=body
  curl -s -m 8 -o /dev/null -w '%{http_code}' "$1" -H 'content-type: application/json' -H "x-api-key: $2" -d "$3" 2>/dev/null || echo 000
}
A_OK='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200}'
A_NOMAX='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}]}'
A_STREAM='{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200,"stream":true}'

check "msgs: no credential → 401"       401 "$(code "$BUN_A" '' "$A_OK")"                "$(code "$LITE_A" '' "$A_OK")"
check "msgs: bad credential → 401"      401 "$(code "$BUN_A" 'Bearer nope' "$A_OK")"     "$(code "$LITE_A" 'Bearer nope' "$A_OK")"
check "msgs: bad x-api-key → 401"       401 "$(akey "$BUN_A" 'nope' "$A_OK")"            "$(akey "$LITE_A" 'nope' "$A_OK")"
check "msgs: no max_tokens → 400"       400 "$(code "$BUN_A" 'Bearer tok-bob' "$A_NOMAX")" "$(code "$LITE_A" "Bearer $BOB" "$A_NOMAX")"
check "msgs: worst-case > budget → 402" 402 "$(code "$BUN_A" 'Bearer tok-bob' "$A_OK")"    "$(code "$LITE_A" "Bearer $BOB" "$A_OK")"
# streamed admission (the c07766a class): stream=true must STILL be refused pre-flight —
# a budget bypass here is silent (the request would just stream)
check "msgs: stream=true, > budget → 402" 402 "$(code "$BUN_A" 'Bearer tok-bob' "$A_STREAM")" "$(code "$LITE_A" "Bearer $BOB" "$A_STREAM")"
# x-api-key with a VALID identity reaches admission (not just authn) — proves the header
# is honored end to end, in both impls
check "msgs: valid x-api-key → 402"     402 "$(akey "$BUN_A" 'tok-bob' "$A_OK")"          "$(akey "$LITE_A" "$BOB" "$A_OK")"
# default-deny (ADR-0028 closes the cheap-mode gap): an un-claimed identity is 403 on the
# Anthropic wire in BOTH profiles — a HARD assertion here, no longer a profile difference
check "msgs: un-claimed identity → 403" 403 "$(code "$BUN_A" 'Bearer tok-carol' "$A_OK")"  "$(code "$LITE_A" "Bearer $CAROL" "$A_OK")"

echo "▶ PROFILE DIFFERENCE — informational, expected by ADR-0027 (not a failure):"
bc=$(bun_code 'Bearer tok-carol' "$B_OK"); lc=$(lite_code "Bearer $CAROL" "$L_OK")
echo "  un-claimed identity on the LEGACY wires: bun /v1/generate=$bc (flat budget, no claim concept)"
echo "  · lite /v1/chat/completions=$lc (default-deny 403). Both REJECT; on /v1/messages the"
echo "  403 is now a hard assertion (above) — the bespoke wire keeps the old cheap-mode behaviour."

echo "▶ conformance: $pass/$((pass+fail)) contract cases identical across gateways"
[ "$fail" -eq 0 ] && echo "✅ PASS — the gate contract does not drift between cheap and full mode" || { echo "❌ FAIL — drift detected"; exit 1; }
