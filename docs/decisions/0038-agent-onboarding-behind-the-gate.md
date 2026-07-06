# ADR-0038: Agent onboarding behind the gate — registry writes via the platform API, GitOps as a client

- **Status:** Proposed
- **Date:** 2026-07-06

## Context

The agent catalog has two backends behind the `AgentRegistry` port ([0012](0012-agent-control-plane.md)):
the k8s **Agent CRD** (full profile) and a **DynamoDB table** (cheap profile,
[0031](0031-serverless-substrate-for-the-run-loop.md) — "register agents with a
PutItem, no redeploy"). But the two are not equivalent, and the difference only
became visible when real agents wanted to live *outside* the platform repo (a
tenant-shaped `agents` definitions repo).

In k8s, `kubectl apply` never touches etcd — it goes through the **API server**,
which is where the CRD's guarantees actually live: CEL schema validation, RBAC on
who may write, admission policy, audit. The cheap profile's `PutItem` path (the
`agents-cli`) has **no API server in front of it**: it needs operator AWS
credentials, performs no validation, consults no policy, and stamps no ownership.
Registration is operator-level, not tenant-level — which contradicts the
onboarding model the platform already established for inference
([0021](0021-inference-onboarding-policy.md): tenants self-assert claims through a
gated write path, `POST /claims`).

The lesson, stated once: **the CRD was never the point; the API server was.** The
ephemeral profile doesn't need a CRD equivalent — it needs the API-server
equivalent, and the platform already is one: the front door has authn
([0032](0032-web-console-cognito.md)), authz with per-resource attributes
([0034](0034-egress-sidecar-credential-injection.md)), and a validated,
gate-fronted write precedent (`POST /claims`, [0021](0021-inference-onboarding-policy.md)).

## Decision

**Registry writes go through the platform API: `POST /agents` and
`DELETE /agents/{name}` on the runtime's front door. GitOps (a definitions repo)
is a *client* of that API, not a second write path to the table.**

| Concern | Choice |
|---|---|
| Write path | `POST /agents` (upsert an `AgentSpec`), `DELETE /agents/{name}` — same handler body in every substrate, like all routes ([0031](0031-serverless-substrate-for-the-run-loop.md)). |
| Authn | The caller's verified identity (Cognito id token today) — the same credential as every other write ([0032](0032-web-console-cognito.md)). |
| Authz | `Authorizer.authorize(principal, "agent:register" \| "agent:delete", name, {kind})` — policy can bound *who* may register and *which kinds* (e.g. only some tenants get `claude-code`). |
| Validation | In the handler (the CEL-equivalent): name slug, kind enum, bounded `maxSteps`/prompt length, field allowlist projection (unknown fields dropped). |
| Ownership | `tenant` is **stamped from the verified identity**, never taken from the payload; delete requires the caller's tenant to match the spec's. |
| Port | `AgentRegistry` gains *optional* `put`/`delete`. Dynamo + in-memory implement them; the **kube registry deliberately does not** — in the full profile writes stay `kubectl apply` (the real API server), and the route answers 501. |
| GitOps | The `agents` definitions repo holds specs as JSON + a register script that logs in (code+PKCE, the registered localhost callback) and calls the API. No AWS credentials in the repo at all. CI later does the same with a machine identity. |
| `agents-cli` | Demoted to an explicit operator back-door (break-glass, direct table access) — kept, documented as such. |

### What this preserves from the CRD world

Validation, authorization, ownership, and audit all hold *regardless of which
client writes* — console form, register script, CI, curl. That property belonged
to the API server, not to the CRD format, and this ADR re-homes it. The
symmetric table:

| CRD gave | via | Cheap profile now has |
|---|---|---|
| Schema (CEL) | API server | handler validation |
| Who may write | RBAC | authn + `agent:register` authz |
| Ownership | namespace | tenant stamped from identity |
| Audit | etcd/events | table + gateway logs/traces |
| GitOps | `kubectl apply` → API server | repo → register script/CI → `POST /agents` |

## Consequences

- **+** Tenant-level self-service registration: an agents repo needs a login, not
  AWS credentials. Registration is governed identically to run admission.
- **+** One write path — the table stops being writable around the platform's own
  policy (the cli remains as a documented exception, not a pattern).
- **+** Symmetry with [0021](0021-inference-onboarding-policy.md): claims and
  agents onboard the same way; the platform's "onboarding is policy" stance now
  covers both objects.
- **−** A machine-caller authn path (CI, schedulers) is still owed — the register
  script needs a human's browser login until then. Known seam, deliberately
  deferred until a real trigger/CI consumer forces it (the composite
  human-or-workload authenticator).
- **−** Validation lives in TS, not a declarative schema; if specs grow complex,
  revisit (JSON Schema, or zod at the handler).
- **−** No optimistic concurrency on upsert (last write wins) — acceptable for a
  catalog this small; revisit with a version attribute if it ever matters.

## Relationship

Extends [0012](0012-agent-control-plane.md)'s catalog to a governed write surface;
mirrors [0021](0021-inference-onboarding-policy.md)'s self-service claims write;
rides [0032](0032-web-console-cognito.md)'s human identity and
[0034](0034-egress-sidecar-credential-injection.md)'s attribute-aware authz;
same-handler-everywhere per [0031](0031-serverless-substrate-for-the-run-loop.md).
One-liner: **the cheap profile's registry gets its API server — agent writes go
through the gate (`POST /agents`), tenancy is stamped not asserted, and GitOps
becomes a client of the platform instead of a tunnel around it.**

## Open

- Machine identity for CI/schedulers (composite authenticator) — the trigger for
  the next identity ADR.
- Console "new agent" form — the API exists; the form is UI work when wanted.
- List scoping: `GET /agents` currently returns all tenants' agents (fine for one
  user); scope alongside the runs-read scoping when multi-tenancy gets real.
