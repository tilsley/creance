# sandboxed-agent (Model B, ADR-0020/0022) — a REAL foreign coding CLI in a box.
# Node (Claude Code is a Node CLI) + Bun (the @agent-os launcher) + git/python3 for the agent's
# own `do`. The pod runs the launcher, which launches Claude Code INSIDE the sandbox; Claude
# Code's inference is pointed at the in-cluster gateway, its execution contained by the egress
# wall. The pod carries no model creds — identity is a projected SA token the gateway verifies.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && rm -rf /var/lib/apt/lists/*

# the foreign CLI (Claude Code) + Bun (the launcher imports @agent-os/core, a Bun workspace)
RUN npm install -g bun @anthropic-ai/claude-code

WORKDIR /app
# .dockerignore strips node_modules/.git, so this is source + manifests only.
COPY . .
RUN bun install --frozen-lockfile

# Claude Code refuses --dangerously-skip-permissions under root ("for security reasons"), so the
# contained agent runs unprivileged as the node base image's built-in `node` user (uid 1000).
# Containment is the egress wall + the pod boundary, not uid 0.
USER node

# The pod (examples/sandboxed-agent/k8s-pod.yaml) runs the launcher; default task is baked in.
CMD ["bun", "run", "examples/sandboxed-agent/index.ts"]
