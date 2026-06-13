#!/usr/bin/env bash
# Model B wrapper (ADR-0020/0022) — the shim between the platform's generic egress env and the
# foreign CLI's own vocabulary. runSandboxedAgent injects AGENT_TASK / INFERENCE_GATEWAY_URL /
# AGENT_TOKEN into this command's env; we map them onto Claude Code's, then run it headless.
#
# ANTHROPIC_BASE_URL is the *wire dialect* (the Anthropic Messages protocol), pointed at OUR
# gateway — never at Anthropic. The gateway speaks /v1/messages and translates to Bedrock via
# InvokeModel (ADR-0028). No Anthropic API key or account is involved; the token is the pod's
# verified identity. Claude Code appends /v1/messages to the bare base URL itself.
set -uo pipefail
export HOME="${HOME:-/tmp}"                                   # Claude Code needs a writable config dir
export ANTHROPIC_BASE_URL="$INFERENCE_GATEWAY_URL"           # bare — the CLI adds /v1/messages
export ANTHROPIC_AUTH_TOKEN="${AGENT_TOKEN:-}"              # the SA token the gateway verifies
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-haiku}"   # a label; the claim's model wins server-side
# keep the foreign CLI off every non-model network path (the wall blocks them anyway; silencing
# them keeps the verdict clean instead of littered with harmless NET_BLOCKED noise)
export DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 \
       CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# -p: headless print mode. --dangerously-skip-permissions: this IS the sandbox — let the
# contained agent use its write/bash tools without prompting (containment is the wall, not a prompt).
exec claude -p "$AGENT_TASK" --dangerously-skip-permissions --output-format text
