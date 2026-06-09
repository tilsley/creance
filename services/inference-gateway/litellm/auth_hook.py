"""
Verified-identity auth — M2 of the LiteLLM pivot (ADR-0019 / ADR-0026).

LiteLLM's OSS `custom_auth` seam (its native JWT auth is enterprise-only). We verify the
caller's token OURSELVES, derive the tenant from it (non-forgeable), look up the tenant's
claim (grant + budget + model), and return a `UserAPIKeyAuth`. The request body's `user`
field is *ignored* — identity comes from the signed token, not from what the caller asserts.

  authn   — verify the token (signature, exp, aud) → tenant = a claim (default `sub`)
  grant   — ClaimSource lookup, TTL-cached so the hot path doesn't read the store per
            request (ADR-0026); default-deny when there's no claim
  return  — UserAPIKeyAuth(team_id=tenant, max_budget=claim budget, models=[claim model]);
            the admission hook then reads the VERIFIED tenant + cap from this object

Verifier (behind one env switch, like the Authenticator port on the TS side):
  - prod : RS256/ES256 vs a JWKS (JWT_JWKS_URL) — the cluster's OIDC keys, the same check
           STS does for your IRSA pods.
  - dev  : HS256 shared secret (JWT_HS256_SECRET) — for local tests, no network.

Claim source:
  - prod : DynamoDB `agent-os-claims` (mirror of DynamoClaimSource), keyed by serviceAccount.
  - dev  : CLAIMS_STATIC='{"bob":{"model":"claude-haiku","monthlyBudgetUsd":50}}'.

Register:  general_settings: { custom_auth: auth_hook.user_api_key_auth }
"""
import json
import os
import time

import jwt
from fastapi import HTTPException
from litellm.proxy._types import UserAPIKeyAuth

TENANT_CLAIM = os.getenv("JWT_TENANT_CLAIM", "sub")
AUDIENCE = os.getenv("JWT_AUDIENCE")  # if set, the token's `aud` must match


# --- claim source (mirror of DynamoClaimSource; static seam for dev/test) -----
class StaticClaimSource:
    name = "static"

    def __init__(self, mapping: dict):
        self.m = mapping

    def for_tenant(self, tenant: str):
        return self.m.get(tenant)


class DynamoClaimSource:
    name = "dynamodb"

    def __init__(self):
        import boto3  # lazy — dev/static mode needs neither boto3 nor creds

        self.table = os.getenv("CLAIMS_TABLE", "agent-os-claims")
        kwargs = {"region_name": os.getenv("REGION", "eu-west-2")}
        if os.getenv("CLAIMS_TABLE_ENDPOINT"):
            kwargs["endpoint_url"] = os.environ["CLAIMS_TABLE_ENDPOINT"]
        self.ddb = boto3.client("dynamodb", **kwargs)

    def for_tenant(self, tenant: str):
        r = self.ddb.get_item(TableName=self.table, Key={"serviceAccount": {"S": tenant}})
        it = r.get("Item")
        if not it:
            return None
        return {"model": it["model"]["S"], "monthlyBudgetUsd": float(it["monthlyBudgetUsd"]["N"])}


def _build_claim_source():
    if os.getenv("CLAIMS_STATIC"):
        return StaticClaimSource(json.loads(os.environ["CLAIMS_STATIC"]))
    return DynamoClaimSource()


# --- TTL cache: keep the grant lookup off the hot path (ADR-0026) ------------
_MISS = object()


class TTLCache:
    def __init__(self, ttl: float):
        self.ttl = ttl
        self.d: dict = {}

    def get(self, key: str, now: float):
        e = self.d.get(key)
        if e is not None and now - e[1] < self.ttl:
            return e[0]  # may be None — a cached "no claim", which is still a hit
        return _MISS

    def put(self, key: str, val, now: float):
        self.d[key] = (val, now)


# --- the verifier ------------------------------------------------------------
_SA_TOKEN = "/var/run/secrets/kubernetes.io/serviceaccount/token"
_SA_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"


def _verify(token: str) -> dict:
    opts = {"verify_aud": AUDIENCE is not None}
    jwks_url = os.getenv("JWT_JWKS_URL")
    if jwks_url:
        from jwt import PyJWKClient

        # The k8s JWKS endpoint (/openid/v1/jwks) usually needs auth (anonymous access is
        # off); authenticate the fetch with the gateway pod's OWN SA token (JWKS_TOKEN_FILE
        # to override). Trust the cluster CA for THIS fetch via a scoped ssl_context — NOT
        # the global SSL_CERT_FILE, which would clobber the public CA bundle and break TLS
        # to Bedrock et al. (JWKS_CA_FILE to override; omit for a public JWKS).
        headers = {}
        tok_file = os.getenv("JWKS_TOKEN_FILE", _SA_TOKEN)
        if os.path.exists(tok_file):
            with open(tok_file) as f:
                headers["Authorization"] = "Bearer " + f.read().strip()
        ctx = None
        ca_file = os.getenv("JWKS_CA_FILE", _SA_CA)
        if os.path.exists(ca_file):
            import ssl

            ctx = ssl.create_default_context()  # default public CAs +
            ctx.load_verify_locations(cafile=ca_file)  # the cluster CA, for the JWKS host only
        key = PyJWKClient(jwks_url, headers=headers, ssl_context=ctx).get_signing_key_from_jwt(token).key
        return jwt.decode(token, key, algorithms=["RS256", "ES256"], audience=AUDIENCE, options=opts)
    secret = os.environ["JWT_HS256_SECRET"]  # dev/test
    return jwt.decode(token, secret, algorithms=["HS256"], audience=AUDIENCE, options=opts)


_claims = _build_claim_source()
_cache = TTLCache(float(os.getenv("CLAIM_CACHE_TTL", "5")))


async def user_api_key_auth(request, api_key: str) -> UserAPIKeyAuth:
    token = (api_key or "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing bearer token")

    # 1. authn — verify the token; the tenant is the signed identity, not the body's `user`
    try:
        claims = _verify(token)
    except Exception as e:  # bad signature / expired / wrong aud
        raise HTTPException(status_code=401, detail=f"invalid token: {e}")
    tenant = claims.get(TENANT_CLAIM)
    if not tenant:
        raise HTTPException(status_code=401, detail=f"token missing '{TENANT_CLAIM}' claim")

    # 2. grant — TTL-cached claim lookup; default-deny when there's none
    now = time.time()
    grant = _cache.get(tenant, now)
    if grant is _MISS:
        grant = _claims.for_tenant(tenant)
        _cache.put(tenant, grant, now)
    if grant is None:
        raise HTTPException(status_code=403, detail=f"no inference claim for '{tenant}'")

    # 3. carry the verified identity + grant into the request
    return UserAPIKeyAuth(
        api_key=api_key,
        team_id=tenant,
        max_budget=grant["monthlyBudgetUsd"],
        models=[grant["model"]],
        metadata={"tenant": tenant},
    )
