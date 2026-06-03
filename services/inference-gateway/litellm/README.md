# LiteLLM inference gateway — the bought engine + our budget hard-stop

**Milestone 1 of the LiteLLM pivot (ADR-0024/0025).** Proves the bet: *buy the engine
(LiteLLM → Bedrock), build the policy (a worst-case admission hook)* — and the budget
hard-stop survives on LiteLLM, firing a real `402` before a single token is spent.

LiteLLM owns wire formats, model routing, and the Bedrock call. `admission_hook.py` owns
the ~10% nobody else does: price each request's worst case (`input + max_tokens` of
output) **pre-flight** and refuse if it won't fit the tenant's cap — reserving against the
**same DynamoDB spend table** (`agent-os-budgets`) the TS runtime uses, so one counter
serves both.

| File | What it is |
|---|---|
| `admission_hook.py` | The Python port of `AdmissionInferenceProvider` — `async_pre_call_hook` (price → atomic reserve → 402), `async_post_call_success_hook` (settle actual), `async_post_call_failure_hook` (refund). |
| `config.yaml` | LiteLLM proxy config — Bedrock Claude Haiku (keyless), loads the hook as a callback. |
| `pyproject.toml` | `litellm[proxy]` + `boto3`, managed by [uv](https://docs.astral.sh/uv/). |

## Run it locally

> Not run in this repo's CI — it needs a Python env, live AWS creds, and Bedrock access.
> This is the recipe to validate it yourself.

**Prereqs**
- Python 3.11+
- AWS creds with Bedrock + DynamoDB access. Per the project convention, pass the profile
  explicitly (creds are short-lived, ~1h): `export AWS_PROFILE=nathan-tilsley-developer`
- Bedrock Claude Haiku enabled on the account (Marketplace subscription **and** an IAM
  invoke grant — both required) — or point at DynamoDB Local + skip the real model call.
- The `agent-os-budgets` table (the StateStack budgets table), **or** DynamoDB Local with
  a table `agent-os-budgets` (PK `tenant` S, SK `period` S).

```bash
cd services/inference-gateway/litellm
uv sync                                          # creates .venv + installs from pyproject.toml (uv.lock)

export AWS_PROFILE=nathan-tilsley-developer      # short-lived; refresh on ExpiredToken
export REGION=eu-west-2
export SPEND_TABLE=agent-os-budgets
# export SPEND_TABLE_ENDPOINT=http://localhost:8000   # only for DynamoDB Local
export GATE_BUDGET_USD=0.001                      # tiny cap so the worst-case trips the 402
# export SESSION_BUDGET_USD=0.0005                # optional per-session runaway cap

uv run litellm --config config.yaml --port 4000
```

## See the 402 (the whole point)

With `GATE_BUDGET_USD=0.001`, a normal request's worst case (`input + max_tokens × out`)
exceeds the cap, so admission refuses it **before** calling Bedrock:

```bash
curl -s localhost:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-haiku",
    "messages": [{"role":"user","content":"write a haiku about budgets"}],
    "max_tokens": 200,
    "user": "acme"
  }' | jq
# → HTTP 402  {"error": {"message": "budget exceeded for tenant 'acme'", ...}}
```

Raise the cap (`GATE_BUDGET_USD=5.00`, restart) and the same call returns a normal
completion; the post-call hook settles the **actual** cost down from the reservation.
Omit `max_tokens` → `400` (uncapped output is refused by design).

Watch the counter move:

```bash
aws dynamodb get-item --table-name agent-os-budgets \
  --key '{"tenant":{"S":"acme"},"period":{"S":"2026-06"}}' | jq '.Item.spentUsd'
```

## Where the tenant comes from (and the honest gap)

This milestone reads the tenant from the request — `user` or `metadata.tenant`. It is
**asserted, not verified**: a caller could claim any tenant. That's fine for a local
proof; it is *not* the isolation guarantee ADR-0019 requires.

## Next milestones (not in this slice)

1. **Verified-identity mapping** — a `user_api_key_auth` hook that verifies the SA/IAM
   bearer and derives the tenant (non-forgeable), replacing the asserted `user` field.
   This is what makes the tenant boundary real (ADR-0019/0025).
2. **Cap from the claim** — read `monthlyBudgetUsd` from the Dynamo claims table
   (`DynamoClaimSource` parity) instead of the flat `GATE_BUDGET_USD` env default.
3. **Point the runtime at it** — switch `GatewayInferenceProvider` from the bespoke
   `/v1/generate` to LiteLLM's OpenAI `/v1/chat/completions`, then retire the Bun gateway.
4. **Multi-format** — expose Anthropic `/v1/messages` for Claude Code / the Anthropic SDK
   (the coding-agent use case), same hook in front.
5. **Postgres/Redis store** — swap the DynamoDB store for the ADR-0023 backends.

## Validated locally (litellm 1.87.0)

Run with `GATE_BUDGET_USD=0.0001`, **no AWS creds needed** — the 402/400 paths refuse
*before* any Bedrock call:

- worst-case > cap → `402 budget exceeded: worst-case $0.0008 > cap $0.0001` ✓
- missing `max_tokens` → `400 max_tokens is required` ✓
- neither request reached Bedrock (the hook intercepts pre-flight) ✓

**Gotcha found & fixed:** the proxy calls `async_pre_call_hook` with
`call_type="acompletion"` (the *async* form), not `"completion"` — the guard must accept
both or the hook silently passes every request through to the model. (This is the kind of
cross-version drift the pin guards against.)

## Validation caveats (read before trusting it)

- **Hook signatures** are pinned to `litellm>=1.55,<2` (validated on 1.87.0; see
  `pyproject.toml`). They have drifted across versions — if the proxy errors loading the
  callback, check the installed version's `CustomLogger` signatures against this file.
- **Reservation carry** (pre → post) is threaded via `data["metadata"]["_admission"]`.
  Confirm your LiteLLM version threads the same `data`/`metadata` dict into
  `async_post_call_success_hook`; if not, settle won't fire and reservations won't
  reconcile down to actual (fails *closed* — conservative, but over-charges). This is the
  one behaviour to verify on the first real run.
