/**
 * @agent-os/core — the platform runtime.
 *
 * Ports (contracts) + the L1 agent loop + adapters. Consumed by examples and
 * (soon) the real services, so there's one contract, not a copy per app.
 */
export * from "./ports";
export * from "./loop";
export * from "./sandboxed-agent"; // sandboxed-agent kind (ADR-0019, Model B)
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
export * from "./adapters/scripted-inference"; // deterministic demo/test driver (ADR-0017)
export * from "./adapters/admission-inference"; // cost hard-stop decorator (ADR-0013)
export * from "./adapters/gateway-inference"; // inference-gateway client (ADR-0019)
// do
export * from "./adapters/agentcore-sandbox";
export * from "./adapters/e2b-sandbox";
export * from "./adapters/local-sandbox";
// guard
export * from "./adapters/bedrock-guard";
export * from "./adapters/noop-guard";
// gate: budget governance
export * from "./adapters/local-gate";
export * from "./adapters/noop-gate";
// authn (ADR-0015): who is the caller — swappable per stack
export * from "./adapters/static-token-authenticator";
export * from "./adapters/mesh-trust-authenticator";
export * from "./adapters/mesh-identity-authenticator"; // full-mode workload authn — Linkerd/Istio stamped identity (ADR-0028)
export * from "./adapters/noop-authenticator";
// authz (ADR-0015): allow/deny policy seam
export * from "./adapters/allow-all-authorizer";
export * from "./adapters/opa-authorizer";
export * from "./claims"; // ClaimSource port — inference grant is policy, not provisioning (ADR-0021)
export * from "./adapters/kube-claim-source"; // unified claim reader: budget cap + SA→tenant (ADR-0021)
export * from "./adapters/dynamo-claim-source"; // the non-k8s ClaimSource — grants in DynamoDB (ADR-0021)
export * from "./adapters/static-claim-source"; // dev/test ClaimSource from CLAIMS_STATIC (mirror of the LiteLLM hook's)
export * from "./adapters/dynamo-spend-store"; // durable monthly spend counter (ADR-0013)
export * from "./adapters/postgres-spend-store"; // full-mode ACID budget reserve — one conditional UPDATE (ADR-0023/0026/0028)
export * from "./adapters/sts-tenant-credentials"; // per-tenant assume-role identity (ADR-0014)
export * from "./adapters/local-credential-broker";
export * from "./adapters/noop-credential-broker";
export * from "./adapters/obo-token-vault-broker"; // on-behalf-of token exchange (ADR-0010)
// tools (#4): MCP gateway
export * from "./adapters/mcp-tool-provider";
export * from "./adapters/gateway-tool-provider"; // centralized tool-gateway client (ADR-0011 dir. b, 0029)
// remember: semantic memory (ADR-0030) — the port + files-first (keyword) and vector (Bedrock) adapters
export * from "./memory";
export * from "./adapters/files-memory";
export * from "./adapters/bedrock-embeddings";
export * from "./adapters/vector-memory";
// remember: durable run store
export * from "./adapters/dynamodb-run-store";
// #5: agent control plane — CRD-backed registry
export * from "./adapters/kube-agent-registry";
// record
export * from "./adapters/console-telemetry";
export * from "./adapters/otel-telemetry";
