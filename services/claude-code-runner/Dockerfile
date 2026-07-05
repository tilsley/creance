# claude-code-runner — headless Claude Code as a Fargate task-per-run (ADR-0033).
# Bun runs the task.ts shim (run store + event mirroring); the Claude Code native
# binary is the actual agent. Build context is the repo root (workspace install),
# same as the agent-runtime image.
#
# POC NOTE: installs ALL workspace deps like the agent-runtime image — the shim only
# needs @agent-os/core + the AWS SDK. TODO: multi-stage / split lockfile (shared debt).
# Pinned to the bun that wrote bun.lock: a floating oven/bun:1 (e.g. 1.3.14) has
# re-resolved instead of honoring the lock and picked a yanked vite version.
FROM oven/bun:1.3.4

# git for real coding tasks; curl + certs to fetch the Claude Code installer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Go toolchain — the registered repos include Go projects (chart-val) and a coding
# run must be able to `go build` / `go test` its own changes. Official tarball, not
# apt (debian's golang lags releases). Bump the version alongside the repos' go.mod.
ARG GO_VERSION=1.25.6
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /app
# .dockerignore strips node_modules/.git, so this is source + manifests only.
COPY . .
# Install as root (bun's cache hardlinking breaks as a non-root user in Docker);
# node_modules stays root-owned + world-readable — the runtime only reads it.
RUN bun install --frozen-lockfile

# NON-ROOT at runtime is load-bearing, not hygiene: `--permission-mode
# bypassPermissions` refuses to run as root, and the whole runner depends on it
# (no human to approve). Writes happen under $HOME (workspace, ~/.claude).
USER bun
ENV HOME=/home/bun
ENV PATH="/home/bun/.local/bin:${PATH}"
# The Claude Code native binary (no Node needed) -> ~/.local/bin/claude. Version
# floats to latest at image build (= every cdk deploy); auto-update at RUNTIME is
# disabled by task.ts (DISABLE_AUTOUPDATER=1) so a task runs what was built.
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && claude --version

# Each run works under $HOME/workspace/run-<id> (task.ts mkdirs it; WORKSPACE_DIR overrides).
# Auth: CLAUDE_CODE_OAUTH_TOKEN is injected by ECS from SSM — never baked into the image.
CMD ["bun", "run", "services/claude-code-runner/task.ts"]
