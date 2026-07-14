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

# One image, FOUR entrypoints (ADR-0031 / ADR-0042 GCP sibling) — the substrate picks
# which; no second build, all share deps + adapter wiring.
#   server.ts       (default) the always-on HTTP front door        — full-k8s
#   task.ts         the Fargate task-per-run executor (RUN_ID env) — serverless executor
#     command: ["bun", "run", "services/agent-runtime/task.ts"]
#   lambda.ts       the front door on Lambda (Runtime API loop)    — serverless front door
#     command: ["bun", "run", "services/agent-runtime/lambda.ts"]
#   agent-engine.ts the loop on GCP Vertex Agent Runtime           — managed GCP profile
#     AGENT_ENTRYPOINT=services/agent-runtime/agent-engine.ts  (env, not command)
# server.ts and lambda.ts serve the SAME handler (app.ts); only the server differs.
# Defaults to INFERENCE_PROVIDER=bedrock / SANDBOX_PROVIDER=agentcore (override via env).
#
# ECS/Lambda select the entrypoint by overriding `command`. GCP Agent Runtime canNOT
# override command (its API exposes only env) — so the CMD is an env-indirection it can
# steer via AGENT_ENTRYPOINT. `exec` keeps bun as PID 1 (signals/telemetry-flush intact);
# the default is unchanged (server.ts), so the command-overriding profiles are unaffected.
ENV AGENT_ENTRYPOINT=services/agent-runtime/server.ts
CMD ["sh", "-c", "exec bun run $AGENT_ENTRYPOINT"]
