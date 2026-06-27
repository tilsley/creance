# ADR-0029: Governed egress — every agent outbound flows through a bounding choke point

- **Status:** Accepted (the one owed build — the centralized tool/MCP gateway — is built,
  in-cluster-proven, and chart-integrated; 2026-06-17)
- **Date:** 2026-06-14 (accepted 2026-06-17)

## Context

We've stood up several network choke points piecemeal, each justified locally: the inference
gateway ([0019](0019-inference-gateway.md)/[0028](0028-own-the-gateway-engine.md)) for `think`,
the sandbox + egress wall/proxy ([0020](0020-sandbox-execution-model.md)/[0022](0022-sandbox-backends-for-coding-agents.md))
for `do`'s execution and raw network, the tool/MCP path ([0007](0007-tools-and-external-auth.md)/[0011](0011-tool-mcp-gateway.md))
for `do`'s tools. Mapping the resource model surfaced two questions the per-component ADRs don't
answer *together*:

1. **Are these new primitives?** Is the Squid egress proxy a primitive? Is a centralized MCP
   gateway? Where do they sit?
2. **Which choke points still need building — and does `remember` need a gateway too?**

Answering piecemeal re-derives the same reasoning every time. This ADR names the *pattern* once,
maps every agent outbound to its choke point, settles primitive-vs-control, and records the
`remember`-gateway question (considered, declined) with its reasoning — so the next "do we need a
gateway for X?" has a written home and a test.

## The principle

**No agent reaches outward un-governed. Every outbound — model inference, raw network, tools,
memory — flows through a choke point that does two jobs:**

- **(a) holds the credential** the downstream needs, so the agent — model-generated, prompt-
  injectable — never holds a *stealable* secret; and
- **(b) imposes a bounding policy** on the authorized capability, so a *hijacked* agent's blast
  radius is what policy allows, not what the capability could do.

The agent pod is left **credential-less and reach-less**: nothing in it to steal, nowhere it can
go un-governed. This generalizes the mesh-mode inference property (no token in the pod —
[0028](0028-own-the-gateway-engine.md)) to all egress.

## The map — outbound → choke point

| Agent outbound | Choke point | (a) credential | (b) bounding policy | Status |
|---|---|---|---|---|
| `think` — model calls | **inference gateway** | holds Bedrock creds | identity + real-time budget | ✅ built (0019/0028) |
| `do` — code/commands | **sandbox** (`SandboxProvider`) | n/a (no egress itself) | isolation; exec confined | ✅ built (0020/0022) |
| `do` — raw network | **egress wall + Squid proxy** | n/a | L3/L4 default-deny + L7 domain allowlist + audit | ✅ built (0020/0022) |
| `do` — structured tools | **tool/MCP gateway** | `CredentialBroker` injects per-call (0010) | per-tenant tool allowlist + policy + audit | ⬜ **concept built; centralized service not** |
| `do` — http fetch | **guarded SSRF-safe fetch** | n/a | SSRF guard, scheme/host limits | ✅ built (0008/0011) |
| `remember` — memory/data | **typed `MemoryStore` port** (no gateway) | keyless/short-lived IAM (0023/0026) | tenant scope + access policy + audit | ✅ stores built; *policy to specify* |
| identity (cross-cutting) | **gate** (authn/authz) | — | verified identity → tenant; OPA (0015) | ✅ built (0009/0015) |
| secrets (cross-cutting) | **CredentialBroker** | holds external creds | server-side injection, never in transcript | ✅ proven (0010) |

## None of these are new primitives

Primitives ([primitives.md](../primitives.md)) are *capabilities the agent invokes* — `think` /
`do` / `remember`. A choke point *constrains* a capability; it is a **control**, or the **adapter**
implementing one, a layer down. The "is it a primitive?" test (irreducible / own backing / invoked
directly) fails for all of them:

- The **Squid egress proxy** and the **sandbox firewall** are adapters of the `do`-containment
  control — E2B's firewall and AgentCore's network mode are the *same control* in other profiles.
- The **MCP/tool gateway** is `do`'s **second face** (per `primitives.md`: workspace/http + MCP
  behind `ToolProvider`) — a governed dispatch surface, not a capability the agent "has".
- The **inference gateway** is the `gate` control over `think` egress, made standalone ([0019](0019-inference-gateway.md)).

Naming matters ([0003](0003-ports-and-adapters.md)): a primitive is *invoked by the agent and
advances the task*; a control *governs and never advances*. Every choke point here is the latter.
So a Model-B agent, Squid, the MCP gateway — all add **no new primitive** (the ADR-0020 finding,
generalized).

## Two threats — and the honest split

The choke point's two jobs map to two different threats, with very different difficulty:

1. **Credential theft** — a hijacked agent exfiltrates a *durable secret*. **Solved** by (a): hold
   no creds (gateway/broker holds them) or hold only short-lived/keyless ones (nothing static to
   steal).
2. **Misuse of authorized access** — even with no stealable cred, the agent *misuses what it
   legitimately holds*: burn budget, call an *allowed* tool with malicious args, exfil to an
   *allowed* domain, bulk-read its tenant's memory. Short creds do nothing here. **Not solved** —
   only bounded. A hijacked agent calling an allowed capability with plausibly-shaped inputs is the
   worst case, and no allowlist catches it.

What we have against #2 is **composition**, not a silver bullet: bound the capability (budget /
allowlist / scoped verbs — (b) above), **least privilege** (minimize what's authorized), `record`
(detect after the fact), `guard` (screen intent — weak but the only intent-aimed control), and
**defense-in-depth across choke points** (a broad memory read still can't *leave* past the egress
wall). The choke points cover each other; that composition is the real containment.

## `remember` — considered a gateway, declined

We asked whether `remember` should get its own gateway, mirroring inference (agent holds no DB
creds; data access becomes a governed choke point). **Decision: no separate gateway — pair the
primitive with an access policy at the typed port.** Reasoning, threat by threat:

- **Theft (a):** memory uses keyless/short-lived IAM ([0023](0023-memory-backends-postgres-redis.md)/[0026](0026-gateway-hot-path-authn-authz-budget.md))
  — nothing static to steal. The inference-gateway justification (a stealable cred, a *shared*
  multi-tenant Bedrock footprint, a *real-time budget*) does not transfer to memory.
- **Raw malicious queries:** structurally prevented — **the agent never gets SQL.** It calls a
  *typed* `MemoryStore` port (`store`/`retrieve`/`search`), parameterized by the adapter. The port
  *is* the narrow interface — the same role the MCP gateway plays for tools. Injection-class
  attacks have no surface.
- **Misuse within the verbs** (read-all, bulk-exfil): bounded by tenant scope + `record` audit +
  **egress containment** — even a broad read can't leave past the wall/proxy. Composition, not a
  new service.
- **The one open design choice** (now settled by [0030](0030-memory-model.md): **append-mostly** — the
  agent edits its own memory, destructive bulk-delete is the platform's, git gives audit/rollback for
  the files adapter): should `remember` expose *destructive* ops (delete/overwrite) to
  the agent at all, or be **append-mostly** with deletes reserved to the platform (GC/retention)?
  Leaning append-mostly + platform-side GC. Flagged as the decision to settle when cross-run memory
  is built.

So `remember`'s governance lives at the **port/adapter (a control)**, not a standalone gateway —
because there's no shared-cred or real-time-budget reason to externalize it. An off-the-shelf
memory layer (Mem0/Letta/Zep-class) is admissible only *as an adapter behind that port*, and only
if it upholds the seam: multi-tenant isolation + the constrained, non-SQL verb set.

## Build backlog vs control-to-specify

- **Built (2026-06-14):** the **centralized tool/MCP gateway** ([0007](0007-tools-and-external-auth.md)/[0011](0011-tool-mcp-gateway.md)
  direction (b)) is now a standalone service — `services/tool-gateway` (`POST /tools/list` +
  `/tools/call`) holds the MCP connections, the per-tenant allowlist, and the broker creds; an agent
  resolves + invokes through it via `GatewayToolProvider`, forwarding only identity (it opens no tool
  connection and holds no tool credential). Validated: per-tenant list, server-side execution,
  default-deny on un-permitted tools. **Proven in-cluster** (`deploy/local/tool-gateway-e2e.sh`): an
  agent composes *both* governed chokepoints in one task — `think` → inference gateway → Bedrock and
  `do`-tools → tool gateway → MCP — holding no model creds and no tool creds, only its SA token both
  gateways verify via TokenReview. **Chart-integrated** (2026-06-17): folded into `charts/agent-os`
  as the toggleable `toolGateway` component (auto-injects `TOOL_GATEWAY_URL` into the runtime; the
  whole governed-egress topology is one chart), alongside the still-standalone `charts/tool-gateway`.
  *Follow-ups:* connection pooling (a fresh connect per call today, per [0011](0011-tool-mcp-gateway.md))
  and the AgentCore-managed hosted swap-in.
- **Specify (control, not service):** the `remember` **access policy** — scoped reads, the
  append-mostly / destructive-op stance, volume limits, audit — alongside cross-run memory.

## Consequences

- **+** One named pattern. "Do we need a gateway for X?" now has a **test** — *does X expose a
  stealable cred (→ hold it elsewhere), or an abusable authorized capability (→ bound + audit it)?*
  — and a written precedent instead of a fresh re-derivation each time.
- **+** The agent stays **credential-less and reach-less by construction** across *all* egress —
  the security thesis generalized, and the choke points compose to cover each other.
- **+** Settles primitive-vs-control for Squid / MCP gateway / wall, so the resource model stops
  re-litigating it.
- **−** **Authorized-misuse stays an open problem** — this ADR *bounds and names* it, it does not
  solve it; intent-level defense (`guard`, least privilege) remains weak.
- **−→+** The centralized MCP gateway was the one **explicit, owed build** this ADR named (not a
  vague "tools are handled"). It is now **built, in-cluster-proven, and chart-integrated** — the debt
  is paid; what remains (pooling, hosted swap-in) is optimization, not the load-bearing chokepoint.

## Relationship

Synthesizes the egress/choke-point view across [0019](0019-inference-gateway.md)/[0028](0028-own-the-gateway-engine.md)
(inference gateway), [0020](0020-sandbox-execution-model.md)/[0022](0022-sandbox-backends-for-coding-agents.md)
(sandbox + egress lockdown), [0007](0007-tools-and-external-auth.md)/[0010](0010-credential-broker.md)/[0011](0011-tool-mcp-gateway.md)
(tools/MCP gateway + credential broker), [0023](0023-memory-backends-postgres-redis.md)/[0026](0026-gateway-hot-path-authn-authz-budget.md)
(memory), with the controls of [0008](0008-guard-content-safety-primitive.md) (guard),
[0009](0009-gate-identity-and-governance.md)/[0015](0015-split-authn-authz-ports.md) (gate), and the
on-behalf-of chain of [0016](0016-obo-token-vault.md)/[0017](0017-a2a-identity-propagation.md)/[0018](0018-a2a-protocol-transport.md)
(A2A identity through the gate at every hop). Adds **no new primitive** ([primitives.md](../primitives.md));
it names the pattern the per-component ADRs each implement. One-liner: **every agent outbound goes
through a choke point that holds the credential and bounds the capability — `think`/gateway,
`do`-net/proxy+wall, `do`-tools/MCP-gateway; `remember` keeps its governance at the typed port (no
gateway: keyless creds + a non-SQL interface + egress containment already do the job). Theft is
solved; authorized misuse is bounded, not solved.**
