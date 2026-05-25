/**
 * @agent-os/core — the platform runtime.
 *
 * Ports (contracts) + the L1 agent loop + adapters. Consumed by examples and
 * (soon) the real services, so there's one contract, not a copy per app.
 */
export * from "./ports";
export * from "./loop";
export * from "./config";
export * from "./tools";

// think
export * from "./adapters/bedrock-inference";
export * from "./adapters/ollama-inference";
// do
export * from "./adapters/agentcore-sandbox";
export * from "./adapters/local-sandbox";
// guard
export * from "./adapters/bedrock-guard";
export * from "./adapters/noop-guard";
// record
export * from "./adapters/console-telemetry";
export * from "./adapters/otel-telemetry";
