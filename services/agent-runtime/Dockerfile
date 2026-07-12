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

# One image, THREE entrypoints (ADR-0031) — the substrate picks which by overriding
# the command; no second build, all three share deps + adapter wiring.
#   server.ts  (default CMD) the always-on HTTP front door         — full-k8s
#   task.ts    the Fargate task-per-run executor (RUN_ID via env)  — serverless executor
#     command: ["bun", "run", "services/agent-runtime/task.ts"]
#   lambda.ts  the front door on Lambda (Runtime API loop, no HTTP server)
#     command: ["bun", "run", "services/agent-runtime/lambda.ts"]  — serverless front door
# server.ts and lambda.ts serve the SAME handler (app.ts); only the server differs.
# Defaults to INFERENCE_PROVIDER=bedrock / SANDBOX_PROVIDER=agentcore (override via env).
CMD ["bun", "run", "services/agent-runtime/server.ts"]
