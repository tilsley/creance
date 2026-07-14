# agent-runtime + a Java toolchain — the BYO-container demonstration (ADR-0042).
#
# AgentCore Code Interpreter has no BYO image, but Runtime does: this variant
# bakes JDK 21 + a standalone JUnit runner into the SAME loop image, deployed as
# a second Runtime (agent_os_runtime_java). The loop runs with
# SANDBOX_PROVIDER=local — safe HERE because the per-session microVM is itself
# the isolation boundary (postures §4.3 invoke-and-go): the agent compiles and
# tests Java in its own box, no sandbox hop.
#
# Kept to javac + junit-console (not Gradle): fits the 2 vCPU/8 GB session cap
# and needs no dependency storm at runtime. junit jar pinned at /opt/junit.jar.
FROM oven/bun:1.3.4

RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-21-jdk-headless ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /opt/junit.jar \
      https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.10.2/junit-platform-console-standalone-1.10.2.jar

WORKDIR /app
COPY . .
RUN bun install

ENV PORT=8080
ENV RUNTIME_ENTRYPOINT=services/agent-runtime/agentcore.ts
CMD bun run ${RUNTIME_ENTRYPOINT}
