# Gate conformance suite (ADR-0027)

The two-profiles decision (cheap AWS-native vs full-k8s) ships **two gateway impls** behind one
contract. This suite is what stops them drifting: it asserts the **load-bearing gate contract —
R1 (identity) + R2 (budget) — holds *identically* on both**, sending each gateway the equivalent
request in its own dialect and diffing the outcome.

```bash
make gate-conformance        # or: bash deploy/local/gate-conformance.sh
```

| Gateway | Dialect | Auth | Mode |
|---|---|---|---|
| Bun `inference-gateway` | bespoke `/v1/generate` | static token | cheap (LocalGate, in-memory) |
| LiteLLM | OpenAI `/v1/chat/completions` | JWT `custom_auth` | full (claim budget) |

**The contract (must be identical — proven):**

| Case | Expected | Bun | LiteLLM |
|---|---|---|---|
| no credential | `401` | ✅ | ✅ |
| bad credential | `401` | ✅ | ✅ |
| valid id, no `max_tokens` | `400` | ✅ | ✅ |
| worst-case > budget | `402` | ✅ | ✅ |

Every case rejects **before** the model call ⇒ $0, no AWS, deterministic.

**The one profile difference (informational, by design):** an *un-claimed* identity →
Bun `402` (cheap mode has no claim concept, applies the flat budget) vs LiteLLM `403`
(full mode default-denies without a claim). Both **reject** — only the *mechanism/richness*
differs, which is precisely ADR-0027's "same contract, only richness differs." The suite reports
this rather than failing on it; if you later want cheap mode to also default-deny, this is the
line that would flip to a hard assertion.
