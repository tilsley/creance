# ADR-0008: Guard (content safety) is a third cross-cutting control

- **Status:** Accepted
- **Date:** 2026-05-24

## Context

The model had two cross-cutting controls — gate (identity) and record
(observability). Content safety — harmful-content filtering, PII, denied topics,
hallucination/grounding, and prompt-injection/jailbreak defense — wasn't placed.
It's load-bearing because untrusted tool/MCP/RAG output is a prompt-injection
vector ([ADR-0007](0007-tools-and-external-auth.md)).

## Decision

Add **guard** as a **third cross-cutting control**, alongside gate and record.
(A *control* — cross-cutting, enforced around every action — not a *primitive*,
which is a capability the agent invokes. See [primitives.md](../primitives.md).)

- **Axis:** gate asks "may this *actor* do this *action*?"; guard asks "is this
  *content* safe / allowed / grounded?" Different tech, owners, failure modes.
- **Cross-cutting & in-path:** applied to every `think` and every content crossing
  a trust boundary — input, output, and (critically) untrusted ingress (tool / MCP
  / RAG output re-entering model context). This is the injection defense.
- **Port `ContentGuard`; default adapter Amazon Bedrock Guardrails** — content
  filters (incl. **Prompt Attack**), denied topics, sensitive-info/PII filters,
  contextual grounding, automated reasoning; **`ApplyGuardrail`** screens any
  content independent of model invocation (even non-Bedrock). **Swappable**
  (ADR-0003): Llama Guard, NeMo Guardrails, LLM Guard, Presidio (PII), Lakera
  (injection), Azure AI Content Safety, or LLM-as-judge — composable behind the
  one port. Bedrock Guardrails is the *default*, not the definition.
- **Enforced at the choke points** — `inference-gateway` (model I/O) and
  `tool-gateway` (untrusted output) — not a standalone service. Policy is a
  Bedrock Guardrail config, Crossplane-provisionable per team (future, mirrors
  `InferenceProfile`).

## Why its own control (and why eval is not even a primitive)

Like gate and record: an irreducible concern with its own backing, applied
universally **in-path**. **Eval**, by contrast, is out-of-band, periodic quality assessment —
it composes from inference + observability and isn't in every request path, so
it's not a primitive. Guard is mandatory and synchronous; eval is not.

## Alternative considered

Fold guard into **gate** ("all policy enforcement"). Rejected: actor-authz and
content-safety differ enough in tech, ownership, and placement that conflating
them muddies both. Reversible if it proves over-split.

## Consequences

- Layer-0: **3 primitives (think/do/remember) + 3 controls (gate/record/guard)**.
- `inference-gateway` and `tool-gateway` gain a guard enforcement responsibility.
- More Bedrock dependency (consistent with ADR-0006).

## Relationship

Builds on [ADR-0007](0007-tools-and-external-auth.md) (untrusted tool output =
injection surface guard defends). Updates [primitives.md](../primitives.md) and
[architecture.md](../architecture.md).
