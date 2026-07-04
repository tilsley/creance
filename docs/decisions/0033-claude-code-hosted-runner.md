# ADR-0033: Claude Code as a hosted runner — a foreign harness behind the existing dispatch seam

- **Status:** Proposed (consumes the substrate of [0031](0031-serverless-substrate-for-the-run-loop.md); a third execution `kind` alongside [0019](0019-inference-gateway.md)'s sandboxed-agent; cheap profile of [0027](0027-two-deployment-profiles.md))
- **Date:** 2026-07-04

## Context

The platform can run its own L1 loop per Fargate task ([0031](0031-serverless-substrate-for-the-run-loop.md)),
but for real *coding* tasks the L1 loop is a toy next to a production coding harness: Claude
Code brings its own planner, tool suite (file edit, bash, search), permission model, and
context management. The question is whether a **foreign, self-contained agent harness** can be
hosted on the platform without new machinery — a good stress test of the resource model: if
the objects are right, a harness we didn't write should slot in as *just another executor*.

Constraints, in tension:

1. **Cost.** The operator has a Claude Max subscription — marginal inference cost ≈ $0 via a
   `claude setup-token` OAuth token. Bedrock (the platform's native think-path) would bill
   per token. For a personal POC the subscription wins; for multi-tenant it cannot (one
   person's subscription must not serve other tenants' runs — rate limits and ToS).
2. **Keyless preference.** The token is a static secret (~1-year), which cuts against the
   platform's keyless-identity stance ([0014](0014-per-tenant-workload-identity.md)). Bedrock
   via the task role (`CLAUDE_CODE_USE_BEDROCK=1`, supported natively by the harness) is the
   keyless path and stays one env-var away.
3. **Secret cost.** Secrets Manager is $0.40/secret/mo; an SSM SecureString standard
   parameter under the default `aws/ssm` KMS key is $0 and is natively injectable by ECS
   (`secrets.valueFrom`). CloudFormation cannot create SecureString *values*, so the write is
   one out-of-band `aws ssm put-parameter`; CDK only references the name.
4. **Autonomy.** Headless `-p` mode has no human to approve tools or answer questions.
   `bypassPermissions` (which refuses root — the image must run non-root) makes the
   *container* the permission boundary; an appended system prompt tells the model it is
   unattended. Guardrails are `--max-turns`, a hard `CC_TIMEOUT_MS` kill (a hung harness
   burns Fargate-seconds), and the task role holding nothing but the two tables.

### Alternatives considered

- **Claude Agent SDK in-process** (harness as a library inside our runtime): tighter typed
  control, but it *replaces* the run body rather than composing with it, and couples our
  loop's deps to the SDK. The CLI-in-a-container keeps the foreign harness at arm's length —
  swap/upgrade by rebuilding an image. Revisit if we need per-tool-call policy hooks.
- **Anthropic-hosted execution** (claude.ai/code cloud, scheduled cloud agents): zero infra,
  but exercises none of the platform (no gate, no run store, no resource model learning).
- **Bedrock auth now**: keyless and multi-tenant-clean, but pays per token today for no
  additional learning. Documented as the graduation path, deliberately not the default.
- **Lambda instead of Fargate**: 15-min cap already ruled out for run bodies in
  [0031](0031-serverless-substrate-for-the-run-loop.md); coding tasks routinely exceed it.

## Decision

**Host headless Claude Code as a second Fargate executor behind the existing dispatch seam.
A new `AgentSpec.kind: "claude-code"` selects it; nothing upstream changes.**

- **Routing**: `runTaskDispatch` resolves the run's agent spec; `kind === "claude-code"` picks
  the runner task definition (`ECS_CC_TASK_DEFINITION`/`ECS_CC_CONTAINER_NAME` on the front
  door). Same cluster, subnets, SG, and `RUN_ID` container-override contract. Registering the
  agent is one PutItem ([0031](0031-serverless-substrate-for-the-run-loop.md)) — no redeploy.
- **Runner** (`services/claude-code-runner/`): a Bun shim loads the Run, maps the spec
  (`systemPrompt` → `--append-system-prompt`, `maxSteps` → `--max-turns`, `model` →
  `--model`), spawns `claude -p <task> --output-format stream-json`, mirrors events into the
  run's `messages` as they happen (so the console's poll reads a live transcript — the same
  watch model as the loop), and persists terminal status/output/usage. Non-zero exit on
  failure so ECS surfaces it.
- **Auth**: `CLAUDE_CODE_OAUTH_TOKEN` from `/agent-os/claude-code/oauth-token` (SSM
  SecureString, default key), injected by ECS at task start. The graduation path to keyless
  multi-tenant is env-only: `CLAUDE_CODE_USE_BEDROCK=1` + Bedrock invoke on the task role.
- **Gate invariance**: authn → authz → budget → create-queued-run runs unchanged in the front
  door. R2 (budget) is *admission-only* for these runs today — subscription usage reports
  $0 cost, so there is no spend to settle. That is honest: the platform governs *whether* a
  run starts, and the subscription's own rate limits bound the rest. Real per-run spend
  accounting arrives with the Bedrock path.

## Consequences

- A run created as `POST /runs {"agent":"claude-code","task":"..."}` is a real coding agent
  with zero marginal inference cost and ~$0 idle infrastructure; the UI ([0032](0032-web-console-cognito.md))
  needs no changes to launch or watch one.
- The dispatch seam proved out: a foreign harness landed as one registry item + one task def.
  `kind` now spans loop / sandboxed / claude-code — executor selection is officially the
  registry's job, not the caller's.
- Debt accepted: a static ~1-year token (rotate by re-running `setup-token` + `put-parameter`);
  `kind: "claude-code"` under `DISPATCH=inprocess` would wrongly fall through to the L1 loop
  (serverless-only for now); the workspace is ephemeral — no repo clone/push yet, that's the
  next increment (a git credential via the same SSM pattern, or CodeCommit via the task role).
