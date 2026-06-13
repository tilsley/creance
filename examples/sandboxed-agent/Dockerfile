# sandboxed-agent (Model B, ADR-0020/0022) — a REAL foreign coding CLI in a box, COMPILED.
#
# Stage 1 bundles the launcher + only the code it reaches (@agent-os/core + the AWS/k8s SDKs) into
# one self-contained binary via `bun build --compile`. Stage 2 is just Node (Claude Code is a Node
# CLI) + the CLI + that binary — dropping the ~1GB monorepo workspace install entirely (~3GB → ~1.3GB).
# The pod still carries no model creds; identity is a projected SA token the gateway verifies.

# ---- build: compile the launcher to a standalone binary (this stage is discarded) ----
FROM oven/bun:1 AS build
WORKDIR /app
# .dockerignore strips node_modules/.git/.venv
COPY . .
RUN bun install --frozen-lockfile
RUN bun build examples/sandboxed-agent/index.ts --compile --outfile /launcher

# ---- runtime: Node (for Claude Code) + the CLI + the compiled launcher; no Bun, no node_modules ----
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && rm -rf /var/lib/apt/lists/*

# the foreign CLI (Claude Code) — a Node global; the launcher is self-contained, so Bun is not needed here
RUN npm install -g @anthropic-ai/claude-code

COPY --from=build /launcher /usr/local/bin/launcher
COPY examples/sandboxed-agent/run-claude.sh /usr/local/bin/run-claude-agent
RUN chmod +x /usr/local/bin/launcher /usr/local/bin/run-claude-agent

# a compiled binary's import.meta.dir is a virtual FS path, so point the launcher at the baked wrapper
ENV SANDBOXED_AGENT_CMD="bash /usr/local/bin/run-claude-agent"

# Claude Code refuses --dangerously-skip-permissions under root, so run as the base image's node user.
USER node
CMD ["/usr/local/bin/launcher"]
