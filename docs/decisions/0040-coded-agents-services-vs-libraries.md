# ADR-0040: Running coded agents — enforcement lives in services, convenience lives in libraries

- **Status:** Proposed
- **Date:** 2026-07-12

## Context

`tilsley/agents` holds *coded* agents — the failure-analyst has its own event loop, a
ports-and-adapters architecture, a heuristics pre-pass, a retry policy, and tests. It is
expressible as none of the platform's three kinds: not as a `loop` spec (the agent is data,
our L1 is the code), not in `sandboxed`'s Model B shape, not as a `claude-code`
parameterization (a harness we chose). It has to **bring its own code**. Two candidate
answers surfaced:

1. **Host it** — a fourth `kind: "custom"`: per-run Fargate task running the *agent's*
   image behind the [0031](0031-serverless-substrate-for-the-run-loop.md) dispatch seam,
   with the platform's credential model intact (chosen over AgentCore CI precisely because
   the latter has no seat for the [0034](0034-egress-sidecar-credential-injection.md)
   sidecar and only binary egress).
2. **Don't host it** — the agent runs on its own infra and *copies our pattern* by
   importing the platform's packages as libraries.

Option 2 looks like it contradicts [0019](0019-inference-gateway.md)/[0039](0039-gateway-on-the-serverless-substrate.md)
(we just centralized think into a hosted choke point). It doesn't — but seeing why forces
the principle this ADR exists to record:

**Trust decides what is a service and what is a library.** A library executes in the
caller's process; for foreign code, enforcement shipped as a library is enforcement the
caller can fork, stub, or skip. The in-process gate is sound for the *loop* because the
loop is platform code — enforcer and enforced share a trust domain. The moment code is
foreign, every invariant (R1 identity, R2 budget, credential custody) must sit behind a
network boundary the code cannot cross — which is exactly what the gateway is. The
*client* side of those boundaries, by contrast, carries no authority: token plumbing, the
`/v1/generate` wire, telemetry wiring, even the L1 loop itself, can be published freely.

## Decision

**Name the modes, split the surface along the trust line, and adopt both options as
stages, not rivals.**

- **The surface, split:**
  - *Control points — hosted services, never libraries:* inference gateway (model creds +
    meter/settle), front door (admission, quota), budgets ledger, registration gate
    ([0038](0038-agent-onboarding-behind-the-gate.md)), egress sidecar (credential
    injection).
  - *Conveniences — publishable libraries:* port interfaces, a gateway client (the
    `agents` repo's `think.ts` grown up: login/token handling, generate calls), telemetry
    helpers, the L1 loop for anyone embedding it.
- **A named third mode: the external agent.** Runs on its own infra, imports
  `@agent-os/client`, thinks through the gateway. Its *think* is fully governed —
  verified identity, tenant-metered on the shared ledger — while its *act* path is not
  ours to govern (no sidecar seat on infra we don't run; in the org context that is the
  mesh's job — Istio/OPA — not the platform's). It has **no Run resource**: no admission,
  no quota, no bounds, no kill switch, no transcript. The lesson for the resource model:
  *the Run exists only where the platform owns execution.*
- **Stage 1 (now): extract the client SDK.** Pull the client-side lib out of the
  `agents` repo scripts; the failure-analyst adopts it in place — its `ClassifierLlmPort`
  gets a gateway adapter, its inference becomes governed without moving a byte of it.
  This makes [0038](0038-agent-onboarding-behind-the-gate.md)'s machine-identity seam
  **blocking, not deferred**: a Cognito human login (~1 h id token, browser flow) cannot
  authenticate a service. The composite-authenticator decision comes with this stage.
- **Stage 2 (when an agent needs the platform to hold its credentials): the custom
  kind.** Per-run Fargate, agent-supplied image, sidecar seat, `AGENT_GATEWAY_URL`
  think-path — dispatched through the seam [0033](0033-claude-code-hosted-runner.md)
  proved. Its ADR must decide three things option 1 surfaced:
  1. *Image provenance* — agent-repo CI pushes to platform-account ECR; registration
     validates the image ref against it (`kind: custom` schema grows an `image` field;
     re-opens the CI root-of-trust thread).
  2. *Task-definition lifecycle* — ECS overrides cannot change the image, so registering
     a custom agent must create/update an ECS task definition: `POST /agents` becomes a
     real control-plane operation for the first time.
  3. *Run contract* — the task learns its work from `RUN_ID` and reports through the
     front door with a run-scoped credential (same machine-identity dependency).

### Alternatives considered

- **Enforcement as a library** (gate/spend store in the agent's process): rejected —
  foreign code disabling its own governor is not governance. This is the one reading of
  option 2 that genuinely contradicts 0019.
- **Custom kind first, SDK later**: rejected for sequencing — the SDK is days not weeks,
  meets the failure-analyst where it already runs, and forces machine identity, which the
  custom kind needs anyway.
- **Event-driven onboarding now** (failure-analyst consumes conductor `check_run.failed`
  events; runs are request-driven): sidestepped — something creates a run whose task
  payload is the event. Platform-native event subscriptions are future work, not smuggled
  in here.

## Consequences

- The 0019-vs-libraries "contradiction" resolves into a reusable rule for every future
  surface: *does this carry authority?* → service; otherwise → library.
- The failure-analyst gets governed think without a migration; the platform gets its
  first external-agent tenant and real pressure on the machine-identity seam.
- The custom kind is deferred but no longer vague: image provenance, task-def lifecycle,
  and run contract are its ADR's table of contents.
- Accepted gap, stated honestly: external agents' act-path and lifecycle are ungoverned
  by design. When that gap matters for an agent, that agent is the custom kind's next
  tenant.

## Relationship

Consumes [0039](0039-gateway-on-the-serverless-substrate.md) (the hosted think-path is
what makes the external mode governable at all) and [0038](0038-agent-onboarding-behind-the-gate.md)
(whose machine-identity seam Stage 1 forces); generalizes [0036](0036-foreign-l1-boundary-governance.md)'s
boundary-governance argument from the claude-code runner to all foreign code; keeps
[0034](0034-egress-sidecar-credential-injection.md) as the act-path answer reserved for
hosted kinds. One-liner: **publish the client, never the credentials — an agent that
wants the platform's protection runs on the platform; one that only wants its brain rents
the gateway.**
