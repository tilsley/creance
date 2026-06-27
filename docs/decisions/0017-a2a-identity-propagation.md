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
  flowing through the seams we already have. Demonstrated two ways: in-process
  (examples/a2a-delegation) and across **two real agent-runtime processes**
  (examples/a2a-runtimes) where `call_agent` makes a genuine `POST /runs` to the
  next agent, authenticated by *its own* gate — the chain propagates over the
  network with no leakage.
- The transport: `call_agent` brokers an OBO credential for the target agent and
  forwards the propagated identity in the request; the runtime's `OBO_ACTOR` is the
  agent identity stamped into the `act` claim at each hop.
- **Deferred:** loop/depth guards in policy; a real IdP performing the nesting (vs
  the mock endpoint); adopting a *standard* A2A wire protocol (e.g. Agent2Agent)
  in place of our bespoke `POST /runs` between runtimes.
- **Live, static fidelity (2026-06-24):** the in-cluster multi-agent proof
  (`deploy/local/a2a-multiagent-e2e.sh`, [0018](0018-a2a-protocol-transport.md)) demonstrates
  delegation + gate-at-every-hop + the broker allowlist — but with a **static** delegation token
  (`LocalCredentialBroker`), so the `act` chain is **not yet carried**. Making the nested `act` real
  is exactly a swap to `OboTokenVaultBroker` + a real IdP (the OBO work, [0016](0016-obo-token-vault.md)) —
  no `call_agent` or gate change. So the *propagation path* is proven; the *identity-carrying* half is owed.
