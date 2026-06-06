# LiteLLM inference gateway — the bought engine + our authn & budget hard-stop

**Milestones 1–3 of the LiteLLM pivot (ADR-0024/0025/0026).** Proves the bet: *buy the
engine (LiteLLM → Bedrock), build the policy* — verified-identity authn + a worst-case
budget hard-stop, both in LiteLLM's **OSS hooks** (its native JWT auth is enterprise-only).
Validated live against Bedrock (Claude Haiku 4.5): reserve → call → settle-to-actual.

LiteLLM owns wire formats, model routing, and the Bedrock call. We own the ~10% nobody else
does:
- **M1 — `admission_hook.py`:** price each request's worst case (`input + max_tokens` of
  output) **pre-flight** and refuse (`402`) if it won't fit the cap, reserving against the
  **DynamoDB spend table** (`agent-os-budgets`) the TS runtime uses.
- **M2 — `auth_hook.py`:** verify the caller's token *ourselves* (`custom_auth`), derive a
  **non-forgeable** tenant, look up its claim (grant + budget + model), return
  `UserAPIKeyAuth`. The admission hook then reads the **verified** tenant + cap from that —
  the body's `user` field is ignored.

| File | What it is |
|---|---|
| `auth_hook.py` | M2 — `custom_auth`: offline JWT verify (RS256/JWKS prod, HS256 dev) → tenant; TTL-cached claim lookup (Dynamo or static); `401` bad/no token, `403` no claim. |
| `admission_hook.py` | M1 — `AdmissionInferenceProvider` port: `async_pre_call_hook` (price → reserve → 402), `async_post_call_success_hook` (settle), `async_post_call_failure_hook` (refund). Reads the verified tenant/cap from `user_api_key_dict`. |
| `config.yaml` | LiteLLM proxy — Bedrock Claude Haiku (keyless), loads `custom_auth` + the admission callback. |
| `pyproject.toml` | `litellm[proxy]` + `boto3` + `pyjwt`, managed by [uv](https://docs.astral.sh/uv/). |

## Auth (M2) env

| Env | Purpose |
|---|---|
| `JWT_JWKS_URL` | prod: verify RS256/ES256 against this JWKS (the cluster's OIDC keys) |
| `JWT_HS256_SECRET` | dev/test: verify HS256 with a shared secret (no network) |
| `JWT_TENANT_CLAIM` | which claim is the tenant (default `sub`) |
| `JWT_AUDIENCE` | if set, the token's `aud` must match |
| `CLAIMS_STATIC` | dev/test claim map, e.g. `{"bob":{"model":"claude-haiku","monthlyBudgetUsd":50}}` |
| `CLAIMS_TABLE` / `CLAIMS_TABLE_ENDPOINT` | prod: DynamoDB claims table (default `agent-os-claims`) |
| `CLAIM_CACHE_TTL` | grant-cache TTL seconds (default 5) — keeps the lookup off the hot path |

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
uv sync                                          # .venv + deps from uv.lock

export AWS_PROFILE=nathan-tilsley-developer      # short-lived; refresh on ExpiredToken
export REGION=eu-west-2
export SPEND_TABLE=agent-os-budgets
# export SPEND_TABLE_ENDPOINT=http://localhost:8000   # only for DynamoDB Local
# --- auth is mandatory (M2): the proxy verifies a token + looks up a claim ---
export JWT_HS256_SECRET=testsecret               # dev verifier (prod: JWT_JWKS_URL)
export CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":5}}'  # dev claim
# export SESSION_BUDGET_USD=0.0005               # optional per-session runaway cap

uv run litellm --config config.yaml --port 4000
```

Every request now needs a Bearer token (M2). Mint a dev one:

```bash
BOB=$(uv run python -c "import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))")
```

## See it work (402 hard-stop, then a live call that settles)

**402 before Bedrock** — set the claim budget tiny (`monthlyBudgetUsd: 0.0001`, restart):

```bash
curl -s localhost:4000/v1/chat/completions -H "Authorization: Bearer $BOB" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"max_tokens":200,"user":"acme"}'
# → 402  budget exceeded for tenant 'bob'   (the body's user=acme is ignored — verified identity wins)
```

**A live completion** (budget `$5`) returns a real answer and settles to actual cost:

```bash
curl -s localhost:4000/v1/chat/completions -H "Authorization: Bearer $BOB" \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","messages":[{"role":"user","content":"Reply with one word: ok"}],"max_tokens":500}'
# → 200  ...{"content":"ok"}...      (omit max_tokens → 400)
```

Watch the counter settle to **actual**, not the worst-case reserve:

```bash
aws dynamodb get-item --table-name agent-os-budgets \
  --key '{"tenant":{"S":"bob"},"period":{"S":"2026-06"}}' --query 'Item.spentUsd.N' --output text
```

## Where the tenant comes from

**M2 makes it verified.** `auth_hook.py` verifies the caller's token and sets the tenant
from the signed claim (`sub`); the body's `user` is ignored. A caller cannot spend against
another tenant by asserting one. The grant (budget + model) comes from the tenant's claim,
TTL-cached. (The verifier is offline JWT today — RS256/JWKS in prod, HS256 in dev; an
IAM-SigV4 verifier for non-k8s callers is the documented second adapter.)

## Next milestones (not in this slice)

1. **M4 — point the runtime at it** — switch `GatewayInferenceProvider` from the bespoke
   `/v1/generate` to LiteLLM's OpenAI `/v1/chat/completions`, then retire the Bun gateway.
2. **Hot-path production shape (ADR-0026)** — Redis/in-process grant cache across replicas;
   move the budget reserve to a Postgres conditional `UPDATE`; mesh-trust authn in-cluster.
3. **Multi-format** — expose Anthropic `/v1/messages` for Claude Code / the Anthropic SDK
   (the coding-agent use case), same hooks in front.

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

### M2 — verified identity (no AWS, static claim + HS256 dev tokens)

```bash
export JWT_HS256_SECRET=testsecret
export CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":0.0001}}'
BOB=$(uv run python -c "import jwt;print(jwt.encode({'sub':'bob'},'testsecret',algorithm='HS256'))")
uv run litellm --config config.yaml --port 4000
```

- no token → `401 missing bearer token` ✓
- garbage token → `401 invalid token …` ✓
- **token=bob, body `"user":"acme"` → `402 budget exceeded for tenant 'bob'`** ✓ — the body's
  `acme` is ignored; the verified identity wins, and the cap `$0.0001` came from bob's claim.
- token=carol (no claim) → `403 no inference claim for 'carol'` ✓
- none reached Bedrock ✓

### M3 — live reserve → Bedrock → settle (Claude Haiku 4.5, real AWS)

`CLAIMS_STATIC` budget `$5`, `AWS_PROFILE` loaded, `max_tokens=500`:

- request as `bob` → **`200`**, real completion `{"content":"ok"}` (14 in / 4 out) ✓
- counter before: absent (0); counter after: **`0.000034`** ✓
- worst-case reserved `(14×$1 + 500×$5)/1M = $0.002514` → **settled down to actual
  `(14×$1 + 4×$5)/1M = $0.000034`** — exactly the counter value, proving the
  metadata-threaded reserve→settle reconciliation (the one path the no-AWS tests can't cover).

**Two findings:** (1) the `aws login` credential provider needs **`awscrt`** in the venv
(the AWS CLI bundles it; boto3 didn't) — added to deps. (2) on-demand Claude in eu-west-2
requires the **`eu.` cross-region inference profile** id (`eu.anthropic.claude-haiku-4-5-…`);
the raw model id is rejected as "invalid model identifier".

## Validation caveats (read before trusting it)

- **Hook signatures** are pinned to `litellm>=1.55,<2` (validated on 1.87.0; see
  `pyproject.toml`). They have drifted across versions — if the proxy errors loading the
  callback, check the installed version's `CustomLogger` signatures against this file.
- **Reservation carry** (pre → post) is threaded via `data["metadata"]["_admission"]` —
  **verified working on 1.87.0** (M3: counter settled to actual). It fails *closed* if a
  future version stops threading the same `data` dict (over-charges rather than under-charges);
  re-check the counter-settles-to-actual behaviour after a LiteLLM bump.
