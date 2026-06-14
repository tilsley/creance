# tool-gateway-agent — the e2e agent as a pod. Just Bun + the repo (no python/Claude): it thinks
# via the inference gateway and calls tools via the tool gateway, holding no creds (only its SA token).
FROM oven/bun:1
WORKDIR /app
# .dockerignore strips node_modules/.git/.venv, so this is source + manifests only.
COPY . .
RUN bun install --frozen-lockfile
CMD ["bun", "run", "examples/tool-gateway-agent/index.ts"]
