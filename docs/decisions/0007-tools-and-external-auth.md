# ADR-0007: Tools & external auth — AgentCore Gateway + Identity, behind ports

- **Status:** Accepted
- **Date:** 2026-05-23

## Context

Agents must call tools and external services (e.g. GitHub) with scoped auth, and
interoperate via **MCP**. This is **not** a new Layer-0 primitive — it composes
from `do` (the call) and `gate` (the creds) — but it needs platform components.

## Decision

- **Tool/MCP access = "do" (second face).** A `tool-gateway` component exposes a
  single **MCP endpoint**, turning internal APIs / external services / other MCP
  servers into agent-callable tools with per-tool policy. **MCP is the protocol**,
  not a primitive.
- **External-service auth = "gate".** A **credential broker / token vault** mints
  or stores scoped, short-lived third-party creds (the human × agent token idea,
  generalized), inside/beside `iam-authorizer`.
- **Egress** is governance + the sandbox network mode.
- **Backings (consistent with [ADR-0006](0006-agentcore-execution-environment.md)):**
  AgentCore **Gateway** (APIs/Lambda/services → MCP tools; 2- & 3-legged OAuth to
  protected MCP servers) and AgentCore **Identity** (token vault, inbound +
  outbound auth, workload identity). Behind ports `ToolProvider` +
  `CredentialBroker` ([ADR-0003](0003-ports-and-adapters.md)); AgentCore adapters
  now, swappable later.

## Consequences

- **+** No new primitive; Layer-0 stays at five.
- **+** Managed OAuth + token vault — no rolling our own secret store + OAuth
  flows for v1.
- **−** The `tool-gateway` is a **security chokepoint**: third-party MCP servers
  and tool outputs are untrusted (prompt-injection / exfil) — vet/allowlist
  sources, scope minted creds tightly.
- **−** More AWS lock-in; AgentCore Gateway/Identity are young (see ADR-0006).

## Relationship

Extends ADR-0006 (same AgentCore-managed, ports-and-adapters approach). Realizes
the "Composed capabilities" note in [primitives.md](../primitives.md).
