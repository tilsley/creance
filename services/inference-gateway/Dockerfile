# inference-gateway — the Bun gateway as a pod (ADR-0028): /v1/generate (bespoke) +
# /v1/messages (Anthropic wire). Bun runs TS directly, so there's no build step.
#
# POC NOTE: installs ALL workspace deps (bun resolves the whole workspace) — same
# trade-off as the agent-runtime image. Not size-optimized.
# Pinned to the bun that wrote bun.lock (floating :1 re-resolves and has hit yanked versions)
FROM oven/bun:1.3.4

WORKDIR /app

# .dockerignore strips node_modules/.git, so this is source + manifests only.
COPY . .
# NOT frozen: the shared .dockerignore excludes apps/ (runtime images need no app), so
# workspace membership differs from the committed lock; pinned bun + bun.lock keep versions stable.
RUN bun install

ENV PORT=3100
EXPOSE 3100

# All behaviour is env-selected (ports/adapters seam): AUTHN, CLAIM_SOURCE, GATE,
# SPEND_STORE, MODEL_ALIASES, ... — see charts/inference-gateway/values.yaml.
CMD ["bun", "run", "services/inference-gateway/server.ts"]
