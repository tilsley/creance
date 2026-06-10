# doc-gardener image — the agent runtime (Bun) + the bought engine (the opencode server
# binary, installed by bun from the lockfile pin) + git (clone, allowlist enforcement).
# The agent holds NO model credentials: in-cluster it calls the litellm-gateway service
# and the mesh (Linkerd) stamps its identity (full mode) — or a projected SA token does
# (cheap mode). Build from apps/doc-gardener:  docker build -t doc-gardener:dev .
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# versions are exact in package.json (bunfig: exact = true), so a lockless install is pinned
COPY package.json ./
RUN bun install --production

COPY *.ts ./
COPY fixture /fixture

# opencode keeps state under XDG/HOME — give the non-root runtime a writable home
ENV HOME=/tmp
ENTRYPOINT ["bun", "run", "index.ts"]
