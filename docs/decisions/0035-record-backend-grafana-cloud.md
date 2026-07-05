# ADR-0035: Record backend for the cheap profile — OTLP to Grafana Cloud

- **Status:** Accepted (deployed + verified live 2026-07-05 — `agent.run` trace with run.id/guard/inference spans queryable in Tempo)
- **Date:** 2026-07-05

## Context

`record` is the last cross-cutting control with no deployed backing. The code side
has been done for a while: the loop wraps **every** step in a `TelemetrySink` span —
`agent.run {run.id, agent.task}` → per-turn `turn` spans → `tool.*`, `guard.screen`,
`sandbox.start` — and `OtelTelemetrySink` exports them via standard OTLP env vars.
But nothing ever received a span:

1. **The designed backend was never built.** `DataLogStack` (ADOT collector →
   OpenSearch + S3) is still a comment-only shell — and it's an *always-on* shape:
   an OpenSearch domain is ~$30/mo minimum idling, the collector is another running
   thing. That's the full-profile answer ([0027](0027-two-deployment-profiles.md)),
   not the cheap one.
2. **A wiring bug hid the gap:** the serverless executor set `RECORD=otel`, but the
   config seam reads `TELEMETRY` — so even console-exporter spans were silently off.
   Nobody noticed, because nothing was looking. (Fixed alongside this ADR.)

Meanwhile the console (ADR-0032) sharpened what "watching" means: the run-store
transcript shows **what the agent said and did** (turn-grained, poll-friendly), but
not **how the platform behaved** — step latency, guard verdicts, sandbox session
lifecycle, failures inside a turn. That operator view is exactly what the spans
carry.

One org fact matters ([org context](../platform.md)): Grafana is the observability
standard in the user's world — a Grafana Cloud stack already exists (the janey
`aws-platform` repo ships CloudWatch→Loki forwarding to it), with tooling on top.

## Decision

**Cheap-profile `record` = export OTLP straight to Grafana Cloud (free tier), no
collector in between. The backend is deploy-time config, not code: the sink already
speaks OTLP; we point it at Tempo.**

| Concern | Choice | Why |
|---|---|---|
| Backend | Grafana Cloud free tier (Tempo via the OTLP gateway) | ~$0 at POC volume, zero infra to run, and it's the org-standard pane of glass — the same place the janey logs already land. |
| Path | Task → OTLP/HTTP gateway, **direct** (no ADOT/collector sidecar) | A task-per-run has no place to put a collector without paying idle cost; `SimpleSpanProcessor` already flushes per span, which fits a short-lived task. A collector earns its keep in the full profile, not here. |
| Auth | `OTEL_EXPORTER_OTLP_HEADERS` (Basic, instance:token) from an **SSM SecureString** | Same $0 secret pattern as the claude-code runner token (ADR-0033): default `aws/ssm` key, injected as an ECS secret, never in the template. |
| Wiring | `TELEMETRY=otel` always; endpoint via CDK context (`-c otelEndpoint=…`) | No endpoint ⇒ console exporter ⇒ spans appear in CloudWatch logs (harmless, greppable). Setting one env value flips on real export — the adapter's whole point. |
| Selection | Config, per [0003](0003-ports-and-adapters.md)/[0027](0027-two-deployment-profiles.md) | `record` stays a port. Full profile keeps the documented ADOT → OpenSearch shape (`DataLogStack` remains its placeholder); this ADR fills the cheap cell only. |

### Rejected alternatives

- **Realize `DataLogStack` (ADOT → OpenSearch).** Right shape for the full profile;
  wrong cost shape for a platform whose every other component scales to zero.
- **CloudWatch X-Ray via ADOT.** AWS-native and pay-per-trace, but needs a
  collector/layer in the path and buys a second observability UI nobody else in
  this world uses. Weaker query model for traces than Tempo.
- **Self-hosted Grafana/Tempo on k8s.** The lean-out endpoint on the posture map —
  belongs with the full-k8s profile trip, not the cheap substrate.

## Consequences

- **+** Operator-level visibility with zero idle cost and no new running infra;
  span model already in the code, so this is config + one secret.
- **+** One pane of glass across projects (janey logs, agent-os traces).
- **−** Run data (task text in `agent.task`, tool names) leaves AWS for Grafana's
  cloud — acceptable for a single-operator POC; the full profile keeps data
  in-account, and truncation (500 chars) already bounds what a span carries.
- **−** Free-tier limits (traces retention ~14 days, ingest caps) — fine at POC
  volume; a paid tier or the full profile is the graduation path.
- **−** Per-span HTTP export adds a little latency to each step (SimpleSpanProcessor
  is synchronous-ish); acceptable for turn-grained runs, revisit with batching if
  it ever shows in traces.

## Relationship

Fills the cheap-profile cell of the `record` control ([0027](0027-two-deployment-profiles.md));
the sink/adapter split is [0003](0003-ports-and-adapters.md); secret pattern follows
[0033](0033-claude-code-hosted-runner.md); the console (ADR-0032) remains the
*tenant* view — this is the *operator* view beside it. One-liner: **the loop's spans
finally land somewhere — straight to Grafana Cloud in the cheap profile, ADOT →
OpenSearch reserved for full, selected by env not code.**

## Open

- Console → trace deep-link (a `grafanaExploreUrl` in config.json, keyed by
  `run.id`) — natural follow-up once traces are flowing.
- Logs: ship task stdout to Loki the same way (the janey CloudWatch→Loki forwarder
  pattern is reusable) or keep CloudWatch — decide when log volume justifies it.
- Front-door Lambda spans (gate decisions) — same env vars would light it up;
  start with the executor where the run story lives.
