"""
Worst-case budget admission — the cost hard-stop (ADR-0013), relocated into a LiteLLM
proxy callback (ADR-0024/0025: buy the engine, build the policy).

This is the Python port of `AdmissionInferenceProvider` (packages/core/src/adapters/
admission-inference.ts). LiteLLM owns the undifferentiated 90% — wire formats
(OpenAI / Anthropic), model routing, the Bedrock call. This hook owns the ~10% nobody
else does: price each request's WORST case *before* it is sent and refuse pre-flight if
admitting it would push the tenant over its cap.

    worst = price(input_tokens) + price(max_tokens of output)

Input tokens are knowable now (the prompt is in hand); output is bounded by the
*required* `max_tokens` (an uncapped request is an unbounded bill, so we reject it). If
the worst case won't fit, nothing is sent and nothing is spent — the thing that stops a
single $50 one-shot that accumulation-only budgets (LiteLLM's native max_budget) let
through and only block on the *next* call.

Store — selected by SPEND_STORE (ADR-0023/0026/0027):
  - "dynamo" (default, cheap mode): the existing DynamoSpendStore table (PK `tenant`,
    SK `period`="YYYY-MM", attr `spentUsd`) — same atomic conditional reserve as the TS
    runtime, one shared counter, ~$0 idle.
  - "postgres" (full mode): PostgresSpendStore via SPEND_DATABASE_URL — the reserve is a
    single conditional upsert (`spent+delta ≤ ceiling`), atomic AND ACID-durable in one
    statement; targets Aurora Serverless v2 (scale-to-zero) in prod, a local container in dev.

Tenant: for this milestone, read from the request (`user` field or `metadata.tenant`).
Mapping a *verified* identity (SA/IAM token) onto the tenant via `user_api_key_auth` is
the next milestone — until then the tenant is asserted, not proven.

Register in config.yaml:  litellm_settings: { callbacks: admission_hook.proxy_handler_instance }
"""
import os
from datetime import datetime, timezone

import boto3
import litellm
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

# --- pricing (ported from gate.ts PRICE_PER_MTOK) ----------------------------
# $/token by model, per 1M tokens. Keyed by both the config alias (what data["model"]
# carries pre-call) and the resolved Bedrock id (what the response may carry), so the
# lookup hits whichever name LiteLLM reports; `default` covers the rest.
PRICE_PER_MTOK = {
    "claude-haiku": {"in": 1.00, "out": 5.00},  # Claude Haiku 4.5 (approx); the config alias
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0": {"in": 1.00, "out": 5.00},
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": {"in": 1.00, "out": 5.00},
    "amazon.nova-lite-v1:0": {"in": 0.06, "out": 0.24},
    "amazon.nova-pro-v1:0": {"in": 0.80, "out": 3.20},
    "default": {"in": 0.50, "out": 1.50},
}


def price_tokens_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Price an input/output token split in USD (shared by the worst-case check and
    the post-call actual-cost settle). Mirror of gate.ts:priceTokensUsd."""
    p = PRICE_PER_MTOK.get(model, PRICE_PER_MTOK["default"])
    return (input_tokens * p["in"] + output_tokens * p["out"]) / 1_000_000


def current_period(now: datetime | None = None) -> str:
    """The monthly billing window as 'YYYY-MM' (UTC). A new month is a new key, so the
    budget resets with no cron. Mirror of gate.ts:currentPeriod."""
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m")


def estimate_input_tokens(messages: list) -> int:
    """Fallback ~4-chars/token estimate (gate.ts:estimateInputTokens) for when LiteLLM's
    tokenizer doesn't know the model. Counts text in every message."""
    chars = 0
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, str):
            chars += len(content)
        elif isinstance(content, list):  # OpenAI content-parts / tool blocks
            for part in content:
                chars += len(str(part.get("text", part)))
    return -(-chars // 4)  # ceil


# --- the DynamoDB spend store (parity with adapters/dynamo-spend-store.ts) ----
class DynamoSpendStore:
    """Atomic reserve/settle against the same table the TS DynamoSpendStore uses."""

    def __init__(self):
        self.table = os.getenv("SPEND_TABLE", "agent-os-budgets")
        kwargs = {"region_name": os.getenv("REGION", "eu-west-2")}
        if os.getenv("SPEND_TABLE_ENDPOINT"):  # DynamoDB Local (same env as the TS store)
            kwargs["endpoint_url"] = os.environ["SPEND_TABLE_ENDPOINT"]
        self.ddb = boto3.client("dynamodb", **kwargs)

    def reserve(self, tenant: str, period: str, delta: float, ceiling: float):
        """ADD spentUsd :d iff the result stays <= ceiling — the add and the cap check
        are ONE UpdateItem, closing the check-then-add race. Returns the new total, or
        None if it would breach. Callers pre-check delta <= ceiling so :ceil >= 0."""
        try:
            r = self.ddb.update_item(
                TableName=self.table,
                Key={"tenant": {"S": tenant}, "period": {"S": period}},
                UpdateExpression="ADD spentUsd :d",
                ConditionExpression="attribute_not_exists(spentUsd) OR spentUsd <= :ceil",
                ExpressionAttributeValues={
                    ":d": {"N": str(delta)},
                    ":ceil": {"N": str(ceiling - delta)},
                },
                ReturnValues="UPDATED_NEW",
            )
            return float(r["Attributes"]["spentUsd"]["N"])
        except self.ddb.exceptions.ConditionalCheckFailedException:
            return None  # would breach the cap — nothing added

    def add(self, tenant: str, period: str, delta: float) -> float:
        """Unconditional atomic add — used to settle (reconcile to actual) and to refund."""
        r = self.ddb.update_item(
            TableName=self.table,
            Key={"tenant": {"S": tenant}, "period": {"S": period}},
            UpdateExpression="ADD spentUsd :d",
            ExpressionAttributeValues={":d": {"N": str(delta)}},
            ReturnValues="UPDATED_NEW",
        )
        return float(r["Attributes"]["spentUsd"]["N"])


class PostgresSpendStore:
    """Atomic reserve/settle on Postgres — the production home for the budget (ADR-0023/0026).
    The reserve is ONE conditional upsert: insert-or-add iff the new total stays <= ceiling,
    RETURNING the new total; no row returned = would breach (nothing written). The check and
    the add are a single statement, so concurrent reservations can't both slip past the cap —
    and unlike a cache counter it's ACID-durable. Targets Aurora Serverless v2 (scale-to-zero)
    in prod; any Postgres (local container) in dev. SPEND_DATABASE_URL carries the connection —
    deliberately NOT `DATABASE_URL`, which LiteLLM claims for its own Prisma DB and mutates
    (appends `connection_limit`, which psycopg rejects).
    NOTE: Aurora IAM auth (keyless) needs a token-refresh reconnect hook — documented follow-up;
    dev uses password auth in the URL."""

    def __init__(self):
        from psycopg_pool import ConnectionPool  # lazy — dynamo/cheap mode doesn't need psycopg

        self.pool = ConnectionPool(
            os.environ["SPEND_DATABASE_URL"],
            min_size=1,
            max_size=int(os.getenv("DB_POOL_MAX", "5")),
            open=True,
        )
        with self.pool.connection() as conn:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS budgets (
                       tenant    TEXT    NOT NULL,
                       period    TEXT    NOT NULL,
                       spent_usd NUMERIC NOT NULL DEFAULT 0,
                       PRIMARY KEY (tenant, period))"""
            )

    def reserve(self, tenant: str, period: str, delta: float, ceiling: float):
        """Add `delta` iff the result stays <= ceiling — one atomic statement (the conditional
        UPDATE *is* the reserve). Returns the new total, or None if it would breach. Callers
        pre-check delta <= ceiling so the first-write (INSERT) case is safe."""
        with self.pool.connection() as conn:
            row = conn.execute(
                """INSERT INTO budgets (tenant, period, spent_usd) VALUES (%s, %s, %s)
                   ON CONFLICT (tenant, period) DO UPDATE
                     SET spent_usd = budgets.spent_usd + EXCLUDED.spent_usd
                     WHERE budgets.spent_usd + EXCLUDED.spent_usd <= %s
                   RETURNING spent_usd""",
                (tenant, period, delta, ceiling),
            ).fetchone()
            return float(row[0]) if row else None

    def add(self, tenant: str, period: str, delta: float) -> float:
        """Unconditional atomic add — settle (reconcile to actual) and refund."""
        with self.pool.connection() as conn:
            row = conn.execute(
                """INSERT INTO budgets (tenant, period, spent_usd) VALUES (%s, %s, %s)
                   ON CONFLICT (tenant, period) DO UPDATE
                     SET spent_usd = budgets.spent_usd + EXCLUDED.spent_usd
                   RETURNING spent_usd""",
                (tenant, period, delta),
            ).fetchone()
            return float(row[0])


def _build_spend_store():
    """SPEND_STORE picks the budget backend: dynamo (default — cheap mode, ~$0 idle) or
    postgres (full mode — durable conditional-UPDATE reserve; ADR-0027 profiles)."""
    if os.getenv("SPEND_STORE", "dynamo") == "postgres":
        return PostgresSpendStore()
    return DynamoSpendStore()


def _session_key(session_id: str) -> str:
    return f"session#{session_id}"


def _usage_field(usage, *names) -> int:
    """Read a token count from a usage object/dict under any of the given names — covers both
    OpenAI (prompt/completion_tokens) and Anthropic (input/output_tokens) response shapes."""
    for n in names:
        v = getattr(usage, n, None)
        if v is None and isinstance(usage, dict):
            v = usage.get(n)
        if v:
            return v
    return 0


# --- the hook ----------------------------------------------------------------
class WorstCaseBudget(CustomLogger):
    def __init__(self):
        self.store = _build_spend_store()
        # Tenant cap source. POC: a flat env default (+ optional per-tenant override via
        # GATE_BUDGET_OVERRIDES='{"acme":5.0}'). Next milestone: read the claim's
        # monthlyBudgetUsd from the Dynamo claims table (DynamoClaimSource parity).
        self.default_cap = float(os.getenv("GATE_BUDGET_USD", "1.00"))
        self.session_cap = (
            float(os.environ["SESSION_BUDGET_USD"]) if os.getenv("SESSION_BUDGET_USD") else None
        )

    def _tenant(self, user_api_key_dict, data: dict) -> str:
        # M2: the verified identity (auth_hook set team_id) wins over anything in the body —
        # a caller can't spend against another tenant by setting `user`.
        verified = getattr(user_api_key_dict, "team_id", None) if user_api_key_dict else None
        if verified:
            return verified
        meta = data.get("metadata") or {}
        return data.get("user") or meta.get("tenant") or "default"

    def _input_tokens(self, model: str, messages: list) -> int:
        try:
            return litellm.token_counter(model=model, messages=messages)
        except Exception:
            return estimate_input_tokens(messages)

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict, call_type):
        # LiteLLM tags the call_type by route: "(a)completion"/"(a)text_completion" for the
        # OpenAI endpoints, "anthropic_messages" for /v1/messages. Accept ALL the chat routes —
        # missing one (e.g. anthropic_messages) silently bypasses admission = a budget hole.
        if call_type not in ("completion", "text_completion", "acompletion", "atext_completion", "anthropic_messages"):
            return data

        model = data.get("model", "default")
        max_tokens = data.get("max_tokens") or data.get("max_completion_tokens")
        if not max_tokens:
            # uncapped output = unbounded cost — refuse (the ADR-0013 invariant)
            raise HTTPException(status_code=400, detail="max_tokens is required (uncapped output = unbounded cost)")

        worst = price_tokens_usd(model, self._input_tokens(model, data.get("messages", [])), int(max_tokens))
        # M2: tenant + cap come from the VERIFIED identity (auth_hook → user_api_key_dict),
        # not the asserted body. Fall back to the body/env only when no auth hook is wired.
        tenant, period = self._tenant(user_api_key_dict, data), current_period()
        cap = float(getattr(user_api_key_dict, "max_budget", None) or self.default_cap)

        # a single request larger than the whole cap can never fit
        if worst > cap:
            raise HTTPException(status_code=402, detail=f"budget exceeded for tenant '{tenant}': worst-case ${worst:.4f} > cap ${cap:.4f}")

        # atomically reserve against tenant/month
        if self.store.reserve(tenant, period, worst, cap) is None:
            raise HTTPException(status_code=402, detail=f"budget exceeded for tenant '{tenant}'")

        # then the per-session scope, if active — refund the tenant reserve if it doesn't fit
        session_id = (data.get("metadata") or {}).get("session_id")
        if self.session_cap is not None and session_id:
            fits = worst <= self.session_cap and self.store.reserve(tenant, _session_key(session_id), worst, self.session_cap) is not None
            if not fits:
                self.store.add(tenant, period, -worst)  # refund tenant — nothing admitted
                raise HTTPException(status_code=402, detail=f"session budget exceeded for '{session_id}'")

        # carry the reservation to settle/refund (threaded via metadata)
        data.setdefault("metadata", {})["_admission"] = {
            "tenant": tenant, "period": period, "worst": worst, "session_id": session_id, "model": model,
        }
        return data

    async def async_post_call_success_hook(self, data: dict, user_api_key_dict, response):
        res = (data.get("metadata") or {}).get("_admission")
        if not res:
            return response
        # response is a ModelResponse object (OpenAI path) OR a dict (Anthropic /v1/messages) —
        # read usage from either, else actual=0 silently refunds the whole reserve (under-billing).
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        usage = usage or {}
        # OpenAI usage is prompt/completion_tokens; Anthropic is input/output_tokens.
        prompt = _usage_field(usage, "prompt_tokens", "input_tokens")
        completion = _usage_field(usage, "completion_tokens", "output_tokens")
        actual = price_tokens_usd(res["model"], prompt, completion)
        delta = actual - res["worst"]  # usually negative — settle the over-reservation down
        self.store.add(res["tenant"], res["period"], delta)
        if self.session_cap is not None and res["session_id"]:
            self.store.add(res["tenant"], _session_key(res["session_id"]), delta)
        return response

    async def async_post_call_failure_hook(self, request_data: dict, original_exception, user_api_key_dict, traceback_str=None):
        res = (request_data.get("metadata") or {}).get("_admission")
        if not res:
            return
        # the call cost nothing — fully refund the reservation
        self.store.add(res["tenant"], res["period"], -res["worst"])
        if self.session_cap is not None and res["session_id"]:
            self.store.add(res["tenant"], _session_key(res["session_id"]), -res["worst"])


proxy_handler_instance = WorstCaseBudget()
