# 17. Agent-to-agent identity propagation (the OBO delegation chain)

Date: 2026-05-30

## Status

Proposed (extends [0016](0016-obo-token-vault.md), uses [0015](0015-split-authn-authz-ports.md))

## Context

Agents call other agents (ticket-bot → enrich-bot → …). If each hop dropped the
caller's identity, by the second hop you'd no longer know *which human* the work is
for — only that "some agent" is calling. That breaks both least-privilege (the
downstream can't enforce the user's permissions) and audit (you can't see who
authorized a multi-agent action).

OBO (ADR-0016) already mints a token carrying `sub`=user + `act`=agent. RFC 8693
defines exactly how to extend this across hops: the `act` (actor) claim **nests** —
each delegation wraps the previous one — expressing an ordered chain of actors while
the `sub` stays the originating human.

## Decision

An agent-to-agent call goes through the **same gate** as a human call; the
delegation chain rides along in the token and the gate surfaces it:

- **Propagate via nested `act`.** Each hop's OBO exchange wraps the new agent over
  the prior chain: `act = { sub: thisAgent, act: <prior act> }`. The `sub` (human)
  never changes; the chain grows.
- **`Principal.actors`** — `MeshTrustAuthenticator` flattens the nested `act` into an
  ordered list (most-recent agent first). So at any hop the gate knows the human
  (`subject`) AND the full path of agents acting for them (`actors`).
- **Authz over the chain.** Because `actors` is part of the `Principal` the gate
  hands to the `Authorizer`, OPA can decide on the chain (e.g. cap depth, require an
  agent be permitted to act for a user, forbid loops) — not just the immediate caller.
- **Audit the chain.** The downstream records `sub` + the whole chain, so a
  multi-agent action is fully attributable end to end.

No new port: this is the existing authn (claims, incl. the chain) + OBO broker
(exchange that nests) working across hops. The exchange preserves the user's
identity claims (tenant/subject) so each hop's gate re-authenticates cleanly.

## Consequences

- **The human is preserved and the agent path is known at every hop** — the
  identity foundation for safe multi-agent systems.
- **Least privilege travels with the request**: hop N's downstream still enforces
  the *user's* permissions, and can additionally constrain by the agent chain.
- **Same gate, same broker** — A2A is not a special case; it's the OBO chain
  flowing through the seams we already have. Demonstrated in examples/a2a-delegation
  (alice → ticket-bot → enrich-bot → Jira) with no leakage.
- **Deferred:** loop/depth guards in policy; a real IdP performing the nesting (vs
  the mock endpoint); wiring an A2A transport (e.g. the Agent2Agent protocol) so the
  chain rides real inter-agent calls rather than an in-process hand-off.
