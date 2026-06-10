# Gate conformance suite (ADR-0027 · extended by ADR-0028)

The two-profiles decision (cheap AWS-native vs full-k8s) ships **two gateway impls** behind one
contract. This suite is what stops them drifting: it asserts the **load-bearing gate contract —
R1 (identity) + R2 (budget) — holds *identically* on both**, sending each gateway the equivalent
request in its own dialect and diffing the outcome. Since ADR-0028 it is also the **migration
gate**: LiteLLM must keep passing until the Bun gateway covers everything the deploy path uses —
then it can be retired without the contract silently changing.

```bash
make gate-conformance        # or: bash deploy/local/gate-conformance.sh
```

| Gateway | Dialects | Auth | Mode |
|---|---|---|---|
| Bun `inference-gateway` | bespoke `/v1/generate` + Anthropic `/v1/messages` | static token (+ static claims) | cheap (LocalGate, in-memory) |
| LiteLLM | OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` | JWT `custom_auth` | full (claim budget) |

**The contract (must be identical — proven, 12/12):**

| Case | Wire | Expected | Bun | LiteLLM |
|---|---|---|---|---|
| no credential | legacy | `401` | ✅ | ✅ |
| bad credential | legacy | `401` | ✅ | ✅ |
| valid id, no `max_tokens` | legacy | `400` | ✅ | ✅ |
| worst-case > budget | legacy | `402` | ✅ | ✅ |
| no credential | `/v1/messages` | `401` | ✅ | ✅ |
| bad credential (Bearer) | `/v1/messages` | `401` | ✅ | ✅ |
| bad credential (`x-api-key`) | `/v1/messages` | `401` | ✅ | ✅ |
| no `max_tokens` | `/v1/messages` | `400` | ✅ | ✅ |
| worst-case > budget | `/v1/messages` | `402` | ✅ | ✅ |
| worst-case > budget, `stream: true` | `/v1/messages` | `402` | ✅ | ✅ |
| valid `x-api-key`, > budget | `/v1/messages` | `402` | ✅ | ✅ |
| **un-claimed identity (default-deny)** | `/v1/messages` | `403` | ✅ | ✅ |

Every case rejects **before** the model call ⇒ $0, no AWS, deterministic.

Why the new cases are load-bearing (each guards a bug class found live, ADR-0028):

- **`x-api-key`** — the Anthropic wire carries credentials two ways: `Authorization: Bearer`
  (Claude Code's `ANTHROPIC_AUTH_TOKEN`) and the API's native `x-api-key` (Anthropic SDKs /
  `@ai-sdk/anthropic` `apiKey` — what OpenCode sends). Both the 401 (rejected) and 402
  (honored through to admission) sides are asserted, so neither impl can drop the header.
- **`stream: true` → 402** — streamed admission. LiteLLM's hooks once skipped streamed calls
  entirely (the c07766a settle bug was the other half of that class); a bypass here is silent,
  the request just streams.
- **default-deny → 403** — was the suite's one tolerated "profile difference" (cheap mode
  flat-budget). ADR-0028 closes it on the Anthropic wire: the Bun gateway runs `CLAIM_SOURCE=static`
  (`CLAIMS_STATIC`, the TS mirror of the LiteLLM hook's fixture) and hard-denies un-claimed
  identities, same as full mode.

**The remaining profile difference (informational, by design):** an *un-claimed* identity on
the **legacy bespoke wire** (`/v1/generate`) → Bun `402` (flat budget) vs LiteLLM `403`
(default-deny). Both **reject** — only the *mechanism/richness* differs (ADR-0027's "same
contract, only richness differs"). On `/v1/messages` this is now a hard assertion instead.
