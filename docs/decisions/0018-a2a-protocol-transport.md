# 18. Adopt the A2A (Agent2Agent) protocol for agent-to-agent transport

Date: 2026-05-30

## Status

Proposed (supersedes the bespoke inter-agent hop in [0017](0017-a2a-identity-propagation.md))

## Context

ADR-0017 made agent-to-agent calls real, but over a **bespoke** wire: `call_agent`
did a `POST /runs` to the other runtime and polled `/runs/{id}`. That works only
between agent-os runtimes — it can't call, or be called by, agents built on other
stacks. To be interoperable we should speak the open standard.

**A2A (Agent2Agent)** is that standard (originally Google, now a Linux Foundation
project). Important framing: **A2A is the standard; JSON-RPC 2.0 is the wire format
it's carried over** (like MCP, which we already use for tools — MCP is agent↔tools,
A2A is agent↔agent). A2A defines the *vocabulary*: capability discovery via an Agent
Card, the `Task`/`Message`/`Part`/`Artifact` data model, the task lifecycle, the
methods (`message/send`, `tasks/get`), and a standard HTTP auth model. The identity
work is transport-agnostic, so only the wire + discovery change.

## Decision

Speak A2A for inter-agent calls (core subset):

- **Discovery:** each runtime serves an **Agent Card** at
  `GET /.well-known/agent-card.json` (plain HTTP+JSON, not JSON-RPC) advertising its
  name, the A2A endpoint URL, capabilities, and a **bearer** `securityScheme`.
- **Invocation:** `POST /a2a` is a **JSON-RPC 2.0** endpoint implementing
  `message/send` (create work → return a `Task`) and `tasks/get` (poll). Our `Run`
  maps onto A2A's `Task` (status → `TaskState`; output → a text `Artifact`).
- **Auth:** standard HTTP per the card — the OBO token rides in the `Authorization:
  Bearer` header. `MeshTrustAuthenticator` accepts identity from either its edge
  header or the bearer, so the same gate (authn → authz → budget) runs unchanged and
  the OBO delegation chain (ADR-0017) propagates across the standard hop.
- **Client:** `call_agent` is now an A2A client — discover the card, `message/send`,
  poll `tasks/get`, read the artifact. It replaces the bespoke `POST /runs` hop.
- The REST `POST /runs` API stays for direct/human clients; A2A is the agent↔agent
  surface. JSON-RPC 2.0 is the baseline transport (we don't implement the optional
  gRPC/REST bindings).

## Consequences

- **Interoperable**: any A2A-compliant agent can call ours (discover the card, send a
  message) and ours can call theirs — not just agent-os↔agent-os.
- **Identity unchanged**: OBO chain + gate are transport-agnostic; they ride the
  standard `Authorization` header. The two-process demo (examples/a2a-runtimes) now
  runs over real A2A — card discovery + JSON-RPC — with the chain preserved.
- **One gate, two front doors**: REST `/runs` (humans/direct) and A2A `/a2a` (agents)
  share the same authn→authz→budget→create path (factored into one helper).
- **Deferred:** streaming (`message/stream` over SSE), push notifications,
  `tasks/cancel`, and the optional gRPC/REST transport bindings; richer Agent Card
  skills/auth negotiation.

## Proven in-cluster (2026-06-24)

Beyond the local two-process demo: `deploy/local/a2a-multiagent-e2e.sh` runs **two real
agent-runtime pods** on k3s. `agent-a` is asked an order question but has **no orders tool**, so it
must **delegate** to `agent-b` via `call_agent` over A2A (card discovery → `message/send` →
`tasks/get`). `agent-b` **authenticates the inbound hop** (an *unauthenticated* A2A call gets `401`),
resolves its own agent spec, runs its orders MCP tool, and returns the result — which `agent-a` folds
into its answer. The **broker is the agent allowlist**: a target the caller isn't granted is
default-denied (`no access to agent 'agent-x'`). So the A2A wire + the gate-at-every-hop + the
broker-as-directory all hold live. **Static fidelity** — the identity `act` chain ([0017](0017-a2a-identity-propagation.md))
is a *static* delegation token here; carrying the real **user** through the hops is the OBO
follow-up ([0016](0016-obo-token-vault.md)), a broker-adapter swap with no `call_agent`/gate change.
