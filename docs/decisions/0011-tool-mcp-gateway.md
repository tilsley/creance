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

## Clarification — gateway *shape*, MCP-client placement, and the auth gap (2026-06-24)

A design discussion (while folding the tool gateway into the umbrella chart, [ADR-0029](0029-governed-egress-choke-points.md))
surfaced three things worth pinning down. None reverses the decision; they sharpen what was built —
and correct one imprecision above.

- **Two gateway *shapes* — ours terminates MCP; it is not an MCP endpoint.** The "direction (b)"
  framing above ("a single **MCP** endpoint for any client") describes **AgentCore Gateway**: clients
  speak MCP *to* it — a bilateral MCP router. The self-hosted `services/tool-gateway` is a **different
  shape**: a **tool-resolution** gateway. Callers use its neutral `POST /tools/list|call` HTTP and
  **never speak MCP**; the gateway is the MCP *client* outward — it **terminates** MCP. Both sit behind
  the `ToolProvider` port, but they are not the same wire. Call them **Design A** (tool-resolution —
  ours) and **Design B** (bilateral MCP router — AgentCore Gateway). You need **B** only when the
  client is a **third-party MCP host you don't control** (Claude Desktop, an IDE) and must interpose
  transparently. agent-os **owns its runtime**, so the agent calls our tool API and **A is correct +
  sufficient**. This is why we keep the name **`tool-gateway`** and *don't* call it `mcp-gateway`:
  in the wild that name already denotes **Design B**. Microsoft's
  [`mcp-gateway`](https://github.com/microsoft/mcp-gateway) is *"a reverse proxy and management layer
  for MCP servers… session-aware stateful routing"* that clients connect to **as an MCP server**
  (`POST /mcp`); Docker's *MCP Gateway* and `mcp-proxy` are the same shape. So `mcp-gateway` wouldn't
  be merely vague — it would import a concrete *wrong* model (a session-sticky MCP reverse proxy).
  Our gateways are named by **primitive** anyway (`inference-gateway`, not `anthropic-gateway` —
  though it speaks that wire — nor `bedrock-gateway`), and MCP is a **swappable backend** here
  (AgentCore Gateway is the swap-in). If "tool" ever needs disambiguating from the sandbox tools, the
  right qualifier is **external** (`do`-tools), not the backend protocol.
- **Where the MCP client lives is the real choice — our agents don't speak MCP.** No LLM speaks MCP;
  the model emits provider-native **tool-use** (Bedrock Converse / Anthropic), and the **host** maps
  that to tool execution. MCP is a *tool-source* protocol the host speaks, **not** the model's calling
  convention. The common default (LangChain, the Anthropic SDK, Cursor, Claude Desktop) runs the MCP
  client **in-process** in the agent; we move it **into the gateway** so the agent pod holds no MCP
  connection and no tool credential — a standard **platform-scale** move (cf. Cloudflare / Docker MCP
  gateways), not a deviation. Note the word "tool" spans two buckets: **`do`-execution** (sandbox
  bash/read/write/exec — *sandbox*-governed, [ADR-0020](0020-sandbox-execution-model.md)) vs
  **`do`-tools** (external/MCP — *gateway*-governed). The gateway governs only the latter, and is
  **MCP-only today** behind the `ToolProvider` port.
- **The unbuilt part is authorization, not the gateway — and the static-bearer half is now proven
  against a real server.** `credentialTarget` injects a **static bearer** (Authorization header / stdio
  env) that the **CredentialBroker** mints per tenant (default-deny). As of 2026-06-24 this runs
  against a **real remote MCP server**: GitHub's `https://api.githubcopilot.com/mcp/readonly` over HTTP,
  with a read-only PAT the broker injects — a Bedrock agent reaches **live GitHub issues**, the PAT
  stays server-side, and an ungranted tenant is denied, proven **local** (`examples/github-mcp/`) *and*
  **in-cluster** (`deploy/local/tool-gateway-github-e2e.sh`, the PAT in a k8s Secret mounted only on the
  gateway pod). What remains owed is narrower: servers that require **OAuth 2.1** (Atlassian, Linear —
  dynamic client registration, an authorization-code flow **with consent**, **token refresh**) need the
  **OBO token vault** ([ADR-0016](0016-obo-token-vault.md)) wired to the MCP path, or auth punted to the
  **AgentCore Gateway** swap-in (which provides OAuth). The static-bearer `LocalCredentialBroker` is the
  dev shape; prod mints short-lived tokens (a GitHub-App installation token / the vault) — no static PAT.
  (Owning the loop that drives all this is a separate, deliberate choice — the governance shell of
  [ADR-0024](0024-build-vs-buy-managed-agent-platforms.md), not a consequence of the gateway.)
