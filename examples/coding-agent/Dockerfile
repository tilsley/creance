# coding-agent AS A POD — the platform's first use case, behind the egress wall.
# It's the agent-runtime Bun image PLUS python3, because this pod plays Model A's dual
# role: the trusted agent loop AND the untrusted code it runs (SANDBOX_PROVIDER=local runs
# python3/bash in-process). The pod carries no model creds and no auth code — identity is a
# projected SA token the in-cluster gateway verifies. Build:  docker build -t coding-agent:dev .
FROM oven/bun:1

# python3 = the sandbox `do` runtime (the code the agent writes and runs).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# .dockerignore strips node_modules/.git, so this is source + manifests only.
COPY . .
RUN bun install --frozen-lockfile

# The pod's command (examples/coding-agent/k8s-pod.yaml) overrides this with the task.
CMD ["bun", "run", "examples/coding-agent/index.ts"]
