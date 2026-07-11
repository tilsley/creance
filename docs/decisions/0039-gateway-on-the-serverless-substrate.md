# ADR-0039: The inference gateway on the serverless substrate — scale-to-zero choke point for foreign think

- **Status:** Accepted — deployed and verified 2026-07-11: `GET /healthz` 200 on the
  Function URL, unauthenticated `POST /v1/generate` 401 (fail closed), and a
  Cognito-authenticated generate (`agents` repo `agent-os/think.ts`) returned a
  completion with usage metered into `agent-os-budgets`.
- **Date:** 2026-07-08

## Context

The cheap profile has never deployed the inference gateway. That was a deliberate
[0031](0031-serverless-substrate-for-the-run-loop.md) simplification: the L1 loop
calls Bedrock **direct**, with budget admission wrapped in-process
(`AdmissionInferenceProvider`) — legitimate, because "admission runs wherever the
real model call happens." The gateway ([0019](0019-inference-gateway.md)) only
exists where something *other than platform code* needs to think.

That something has now arrived. Foreign-agent kinds — `sandboxed`
([0020](0020-sandbox-execution-model.md) Model B) and the coming per-run-task
"custom" kind — run **someone else's loop**. Their entire governance story is
"think egresses ONLY via the gateway" (`runSandboxedAgent` injects
`INFERENCE_GATEWAY_URL` + the run's token and refuses to start without it), and on
the serverless substrate there is nothing on the other end of that URL. The
sandboxed kind is wired, tested locally against the in-cluster gateway, and
**undeployable on the cheap profile** — a named-but-unrealized cell, exactly the
shape 0031 fixed for the runtime.

The move is the same one: this is a packaging problem, not a new-port problem. The
gateway is already a small Bun handler over `providersFromEnv()` — all it needs is
a substrate that is reachable from a sandbox, scales to zero, and holds the model
credentials the callers must not have.

## Decision

**Deploy the Bun gateway as a Lambda (container image, native Runtime API loop)
behind a Function URL — the 0031 pattern applied verbatim to
`services/inference-gateway`. Delegated agents get its URL via a NEW env,
`AGENT_GATEWAY_URL`; the loop's own think stays direct.**

| Concern | Choice | Why |
|---|---|---|
| Compute | Lambda container image + Function URL | Generate calls are request-shaped (seconds, not loops) — Lambda's cap is irrelevant here; scales to zero like the front door. |
| Handler | `createGatewayApp(providers)` extracted from `server.ts`; served by `Bun.serve` (pod) or the Runtime-API loop (`lambda.ts`, mirroring the runtime's) | One body, two substrates — same seam 0031 cut for the front door. Both wires survive: `/v1/generate` (bespoke) + `/v1/messages` (Anthropic passthrough, [0028](0028-own-the-gateway-engine.md)). |
| Caller authn | `AUTHN=cognito` — the delegated agent presents the **run's forwarded token** (`AGENT_TOKEN` = the caller's verified id token) | R1 at the choke point: the sandbox proves *whose run it is*, tenant derives from the token, never from the request. Same adapter as the front door ([0032](0032-web-console-cognito.md)). |
| Budget | `GATE=local` + `SPEND_STORE=dynamodb` (`agent-os-budgets`) | R2 where the model call happens: reserve → invoke → settle against the same table the loop meters into — one ledger, both paths. |
| Model creds | The gateway Lambda's role holds Bedrock invoke (the existing scoped policy); callers hold nothing | [0019](0019-inference-gateway.md)'s point, finally true for the cheap profile's foreign agents. |
| Claims | **Deferred** — no `CLAIM_SOURCE`; model = request/`MODEL_ID` fallback | The claims table doesn't exist serverless-side; per-claim routing joins when a second tenant does. |
| Env seam | `AGENT_GATEWAY_URL` on the executor = "where **delegated agents** think"; `INFERENCE_GATEWAY_URL` keeps its meaning = "route **my own** think through a gateway" | The two semantics were about to collide: setting `INFERENCE_GATEWAY_URL` on the executor task would silently flip loop-kind think into gateway-client mode. `process-run` reads `AGENT_GATEWAY_URL ?? INFERENCE_GATEWAY_URL` for sandboxed runs. |

**Deliberately not in this ADR:** flipping the loop's own think through the
gateway (set `INFERENCE_GATEWAY_URL` on the executor and the cheap profile becomes
single-choke-point for ALL inference, the pure [0028](0028-own-the-gateway-engine.md)
shape). That's one env var away, but it puts a Lambda hop and the gateway's
availability in the path of every loop turn — a graduation to take knowingly, not
as a side effect of deploying the gateway.

## Consequences

- **+** The sandboxed/custom kinds become deployable on the cheap profile; foreign
  think is metered and identity-bound whether or not the agent's code cooperates
  (it holds no model credentials — the gateway is its only route to a model).
- **+** ~$0 idle, per-request billing; one more `cdk deploy` in the same app.
- **−** A second Lambda to operate; cold starts add first-token latency for
  delegated agents (same trade as 0031, same answer: measure before optimizing).
- **−** Token lifetime: the forwarded run token is a ~1h Cognito id token — a
  delegated run outliving it loses think mid-run. Acceptable at POC run lengths;
  the machine-identity seam (ADR-0038 open) is where a longer-lived workload
  credential would come from.
- **−** The sandbox must be able to reach the Function URL — for AgentCore CI that
  forces `PUBLIC` network mode (the egress binary), which is exactly why
  write-capable foreign agents belong on the task-per-run shape instead
  (sidecar seat, ADR-0034); this gateway serves both shapes identically.

## Relationship

Realizes [0019](0019-inference-gateway.md)'s choke point in the cheap profile via
[0031](0031-serverless-substrate-for-the-run-loop.md)'s packaging pattern; keeps
[0028](0028-own-the-gateway-engine.md)'s one-engine-both-wires; authn rides
[0032](0032-web-console-cognito.md); unblocks [0020](0020-sandbox-execution-model.md)
Model B and the coming custom kind. One-liner: **the gateway becomes a
scale-to-zero Lambda so foreign agents finally have a governed place to think —
loop think stays direct, and making the gateway the sole path for everything is a
documented one-env-var graduation, not an accident.**

## Open

- Loop-through-gateway graduation (set `INFERENCE_GATEWAY_URL` on the executor) —
  take when the single-ledger/single-choke-point story outweighs the extra hop.
- Longer-lived delegated-run credentials (ties to ADR-0038's machine-identity seam).
- Per-claim model routing serverless-side (needs a claims table + `CLAIM_SOURCE=dynamo`).
- Streaming on `/v1/messages` through a Function URL (buffered today; revisit with
  response streaming if a foreign CLI needs token-by-token).
