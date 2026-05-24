# tool-gateway

**Serves "do" (acting) — not a separate primitive** (see
[primitives.md](../../docs/primitives.md)). *No code yet — responsibility spec.*

The agent's channel to external **tools** and **MCP servers**. "Do" has two faces:
run code (`sandbox-manager`) and **call tools** (here).

## Responsibilities
- Expose internal APIs, external services, and other MCP servers as agent-callable
  tools behind a single **MCP endpoint**; maintain a tool registry + schemas.
- Per-tool governance (*gate*): which agents/teams may call which tools; scope the
  credentials each tool may use (via the credential broker in `iam-authorizer`).
- Route calls; apply egress allowlists; emit tool-call spans to `telemetry-processor`.
- `ToolProvider` port (ADR-0003): **AgentCore Gateway** adapter now.

## Trust
A third-party MCP server is untrusted surface — vet/allowlist sources; treat tool
descriptions and responses as potential prompt-injection / exfil vectors. This is
a governance chokepoint, not just a router. Tool/MCP output is screened by the
**guard** control (`ContentGuard` port; default Bedrock Guardrails) before it
re-enters model context — see
[ADR-0008](../../docs/decisions/0008-guard-content-safety-primitive.md).

## Notes
- Backed by AWS Bedrock AgentCore Gateway (MCP tools + OAuth). See
  [ADR-0007](../../docs/decisions/0007-tools-and-external-auth.md).
- Trusted service → runs `runc`. **Language: TBD.**
