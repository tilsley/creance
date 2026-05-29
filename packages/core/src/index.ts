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
export * from "./tool-gateway"; // #4: assemble per-run toolset from sources
export * from "./runs"; // State primitive (remember): persisted runs
export * from "./agents"; // #5: agent control plane — the registry data model
export * from "./gate"; // gate control: identity + budget
export * from "./credentials"; // gate control: downstream credential broker

// think
export * from "./adapters/bedrock-inference";
export * from "./adapters/ollama-inference";
export * from "./adapters/admission-inference"; // cost hard-stop decorator (ADR-0013)
// do
export * from "./adapters/agentcore-sandbox";
export * from "./adapters/local-sandbox";
// guard
export * from "./adapters/bedrock-guard";
export * from "./adapters/noop-guard";
// gate
export * from "./adapters/local-gate";
export * from "./adapters/noop-gate";
export * from "./adapters/kube-budget-source"; // per-tenant cap from the claim (ADR-0013)
export * from "./adapters/local-credential-broker";
export * from "./adapters/noop-credential-broker";
// tools (#4): MCP gateway
export * from "./adapters/mcp-tool-provider";
// remember: durable run store
export * from "./adapters/dynamodb-run-store";
// #5: agent control plane — CRD-backed registry
export * from "./adapters/kube-agent-registry";
// record
export * from "./adapters/console-telemetry";
export * from "./adapters/otel-telemetry";
