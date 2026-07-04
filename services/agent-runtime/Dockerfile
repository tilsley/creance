# agent-runtime — the L1 agent loop as a service (Bun).
# Bun runs TS directly, so there's no build step.
#
# POC NOTE: installs ALL workspace deps (incl. infra's CDK) because bun resolves
# the whole workspace. Not size-optimized — TODO: multi-stage / split lockfile.
FROM oven/bun:1

WORKDIR /app

# .dockerignore strips node_modules/.git, so this is source + manifests only.
COPY . .
RUN bun install --frozen-lockfile

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
