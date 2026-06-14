# ADR-0011: Tool/MCP gateway — client-side, behind ToolProvider; AgentCore Gateway as swap-in

- **Status:** Accepted
- **Date:** 2026-05-25

## Context

Tools were **hardcoded in TypeScript** (`workspaceTools`, `httpRequestTool`) — to
add one you edit core. A platform needs tools that are *configurable* and
*extensible without code*, governed per tenant. [ADR-0007](0007-tools-and-external-auth.md)
reserved the `ToolProvider` port and chose **MCP** as the protocol + AgentCore
Gateway as the managed backing.

There are two directions: (a) the agent **consumes** external MCP servers' tools,
and (b) the gateway **is** a single MCP endpoint fronting everything for any
client. (b) is exactly AgentCore Gateway.

## Decision

Build (a) thin-local, behind the port; document (b) as the managed swap-in. Same
playbook as ADR-0009/0010.

- **`ToolProvider` port** ([core/tool-gateway](../../packages/core/src/tool-gateway.ts)):
  `resolve({principal, session}) → { tools, close }`. The runtime resolves a
  toolset up front and passes the tools into the loop; the loop is unchanged.
- **Providers:**
  - **`BuiltinToolProvider`** — the in-process tools (workspace + broker-backed
    `http_request`).
  - **`McpToolProvider`** — connects to configured MCP servers via the official
    `@modelcontextprotocol/sdk` client (stdio + Streamable HTTP), `listTools()`,
    and wraps each as an `AgentTool` (`tools/call` on use).
  - **`CompositeToolProvider`** — merges sources, closes them after the run.
- **Governance:** tool names are **namespaced** `server__tool`; each MCP server
  has a **per-tenant allowlist** (default-open if unset); an optional
  `credentialTarget` pulls a scoped credential from the **CredentialBroker**
  (ADR-0010) injected into the server (env for stdio, `Authorization` for HTTP) —
  the secret never reaches the model.
- **Config:** `MCP_SERVERS` (JSON) declares servers; built-in tools are always
  present.
- **Swap-in (no code):** **AgentCore Gateway** — a hosted single MCP endpoint that
  fronts internal APIs / Lambdas / other MCP servers with unified policy + OAuth.
  The `McpToolProvider` then points at one URL instead of many.

## Consequences

- **+** Tools are configurable + extensible via MCP with no code change; reuses the
  gate (policy) + broker (creds) we already built.
- **+** `http_request` + MCP give agents real external reach; uniform `AgentTool`
  surface to the loop.
- **−** MCP servers + their outputs are **untrusted** (ADR-0007 chokepoint —
  injection/exfil): keep allowlists tight, creds least-privilege/short-lived; the
  `guard` control still screens tool output.
- **−** Thin local = in-process aggregation, a fresh connection per run (stdio
  servers spawn a subprocess each run). Connection pooling + the hosted endpoint
  are deferred to the AgentCore Gateway swap-in.
- **−** Adds the `@modelcontextprotocol/sdk` dependency.

## Relationship

Implements the tool half of [ADR-0007](0007-tools-and-external-auth.md); consumes
the `CredentialBroker` ([ADR-0010](0010-credential-broker.md)) and `Principal`
([ADR-0009](0009-gate-identity-and-governance.md)); same ports-and-adapters
discipline as [ADR-0003](0003-ports-and-adapters.md).

## Built — direction (b), self-hosted (2026-06-14)

Direction (b) — "the gateway **is** a single endpoint fronting everything for any client" — was
documented above only as the **AgentCore Gateway** managed swap-in. It now also has a **self-hosted**
realization: `services/tool-gateway` (a standalone Bun service mirroring the inference gateway). It
reuses the same `McpToolProvider` + `CredentialBroker` + authn, but exposes them over HTTP —
`POST /tools/list` (the caller's tenant's permitted tools) and `POST /tools/call` (execute one,
server-side, creds injected). Agents resolve through `GatewayToolProvider` (the client side, behind
the same `ToolProvider` port), forwarding only identity. So 50 agents share one MCP connection pool
and one credential holder, not 50 — the centralization realized in [ADR-0029](0029-governed-egress-choke-points.md)'s
choke-point map, without the AWS coupling. Connection pooling (a fresh connect per call today) and
the managed AgentCore endpoint remain the scale/managed follow-ups.
