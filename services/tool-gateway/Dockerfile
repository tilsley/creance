# tool-gateway — the centralized tool/MCP execution path as a pod (ADR-0011 dir. b, ADR-0029).
# Bun runs TS directly, so there's no build step.
#
# POC NOTE: installs ALL workspace deps (bun resolves the whole workspace) — same trade-off as the
# inference-gateway image. Not size-optimized. stdio MCP servers would need their runtimes baked in
# here; HTTP MCP servers (the production shape) need nothing extra.
FROM oven/bun:1

WORKDIR /app

# .dockerignore strips node_modules/.git/.venv, so this is source + manifests only.
COPY . .
RUN bun install --frozen-lockfile

ENV PORT=3200
EXPOSE 3200

# All behaviour is env-selected (ports/adapters seam): AUTHN, CRED_BROKER, MCP_SERVERS —
# see charts/tool-gateway/values.yaml.
CMD ["bun", "run", "services/tool-gateway/server.ts"]
