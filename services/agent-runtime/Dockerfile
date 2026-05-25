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

# Defaults to INFERENCE_PROVIDER=bedrock / SANDBOX_PROVIDER=agentcore (override via env).
CMD ["bun", "run", "services/agent-runtime/server.ts"]
