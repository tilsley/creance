# Mock Slack + Jira for the EKS field trip — tiny, standalone (no @agent-os/core).
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY server.ts .
USER bun
EXPOSE 9101 9102
CMD ["bun", "run", "server.ts"]
