# agent-runtime — the L1 agent loop as a service (Bun).
# Bun runs TS directly, so there's no build step.
#
# POC NOTE: installs ALL workspace deps (incl. infra's CDK) because bun resolves
# the whole workspace. Not size-optimized — TODO: multi-stage / split lockfile.
# Pinned to the bun that wrote bun.lock: a floating oven/bun:1 (e.g. 1.3.14) has
# re-resolved instead of honoring the lock and picked a yanked vite version.
FROM oven/bun:1.3.4

WORKDIR /app

# .dockerignore strips node_modules/.git, so this is source + manifests only.
COPY . .
# NOT frozen: the shared .dockerignore excludes apps/ (runtime images need no app), so
# workspace membership differs from the committed lock; pinned bun + bun.lock keep versions stable.
RUN bun install

ENV PORT=3000
EXPOSE 3000

# One image, FIVE entrypoints (ADR-0031/0042 + the GCP sibling) — the substrate picks
# which by overriding the command OR (where the host can't override commands) an env
# indirection; no second build, all five share deps + adapter wiring.
#   server.ts       (default) the always-on HTTP front door        — full-k8s
#   task.ts         the Fargate task-per-run executor (RUN_ID env) — serverless executor
#     command: ["bun", "run", "services/agent-runtime/task.ts"]
#   lambda.ts       the front door on Lambda (Runtime API loop)    — serverless front door
#     command: ["bun", "run", "services/agent-runtime/lambda.ts"]
#   agentcore.ts    the executor on AWS AgentCore Runtime (/invocations + /ping contract)
#     RUNTIME_ENTRYPOINT=services/agent-runtime/agentcore.ts    (env — CfnRuntime sets it)
#   agent-engine.ts the loop on GCP Vertex Agent Runtime           — managed GCP profile
#     AGENT_ENTRYPOINT=services/agent-runtime/agent-engine.ts   (env — Agent Runtime sets it)
# server.ts and lambda.ts serve the SAME handler (app.ts); only the server differs.
# Defaults to INFERENCE_PROVIDER=bedrock / SANDBOX_PROVIDER=agentcore (override via env).
#
# ECS/Lambda select the entrypoint by overriding `command`. NEITHER managed runtime can
# (their APIs expose only env), and each arrived with its own indirection var — so the
# CMD honors both, AGENT_ENTRYPOINT winning if ever both are set. `exec` keeps bun as
# PID 1 (signals/telemetry-flush intact); the default stays server.ts, so the
# command-overriding profiles are unaffected.
ENV RUNTIME_ENTRYPOINT=services/agent-runtime/server.ts
CMD ["sh", "-c", "exec bun run ${AGENT_ENTRYPOINT:-$RUNTIME_ENTRYPOINT}"]
