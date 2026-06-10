# LiteLLM inference gateway image (ADR-0024/0026) — the bought engine + our OSS hooks.
# uv-based: installs litellm[proxy] + boto3 + pyjwt + psycopg + awscrt from the lockfile,
# then the config + the two hooks. Runs the proxy in the foreground.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# deps first (cached layer) — pyproject + lockfile only
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# the gateway: config + the admission (M1), auth (M2), and wire-compat hooks
COPY config.yaml admission_hook.py auth_hook.py compat_hook.py ./

EXPOSE 4000
ENTRYPOINT ["uv", "run", "litellm", "--config", "config.yaml", "--port", "4000", "--num_workers", "1"]
