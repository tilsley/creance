/**
 * The ports/adapters seam as config (ADR-0003): build the four building blocks
 * from environment variables. Shared by the example CLI and the services so
 * there's one wiring, not a copy per consumer.
 *
 * Call ONCE per process — the OTel telemetry sink registers a global provider.
 */
import { BedrockInferenceProvider } from "./adapters/bedrock-inference";
import { OllamaInferenceProvider } from "./adapters/ollama-inference";
import { AgentCoreSandboxProvider } from "./adapters/agentcore-sandbox";
import { LocalSandboxProvider } from "./adapters/local-sandbox";
import { BedrockContentGuard } from "./adapters/bedrock-guard";
import { NoopContentGuard } from "./adapters/noop-guard";
import { ConsoleTelemetrySink } from "./adapters/console-telemetry";
import { OtelTelemetrySink } from "./adapters/otel-telemetry";
import { LocalGate } from "./adapters/local-gate";
import { NoopGate } from "./adapters/noop-gate";
import { StaticTokenAuthenticator } from "./adapters/static-token-authenticator";
import { MeshTrustAuthenticator } from "./adapters/mesh-trust-authenticator";
import { NoopAuthenticator } from "./adapters/noop-authenticator";
import { AllowAllAuthorizer } from "./adapters/allow-all-authorizer";
import { KubeBudgetSource } from "./adapters/kube-budget-source";
import { DynamoSpendStore } from "./adapters/dynamo-spend-store";
import { InMemorySpendStore, type SpendStore } from "./gate";
import { KubeStsTenantCredentials, type TenantCredentials } from "./adapters/sts-tenant-credentials";
import { LocalCredentialBroker } from "./adapters/local-credential-broker";
import { NoopCredentialBroker } from "./adapters/noop-credential-broker";
import { McpToolProvider, type McpServers } from "./adapters/mcp-tool-provider";
import { BuiltinToolProvider, CompositeToolProvider, type ToolProvider } from "./tool-gateway";
import { DynamoDBRunStore } from "./adapters/dynamodb-run-store";
import { InMemoryRunStore, type RunStore } from "./runs";
import { InMemoryAgentRegistry, type AgentRegistry, type AgentSpec } from "./agents";
import { KubeAgentRegistry } from "./adapters/kube-agent-registry";
import type { InferenceProvider, SandboxProvider, ContentGuard, TelemetrySink } from "./ports";
import type { Gate, Authenticator, Authorizer } from "./gate";
import type { CredentialBroker } from "./credentials";

export interface Providers {
  inference: InferenceProvider;
  sandbox: SandboxProvider;
  guard: ContentGuard;
  telemetry: TelemetrySink;
  gate: Gate;
  /** authn (who is the caller) — ADR-0015, swappable per stack. */
  authenticator: Authenticator;
  /** authz (may they do this) — ADR-0015; AllowAll today, OPA next. */
  authorizer: Authorizer;
  credentials: CredentialBroker;
  toolProvider: ToolProvider;
  runStore: RunStore;
  agentRegistry: AgentRegistry;
  /** Inference provider scoped to a tenant's assumed role (ADR-0014), or the shared
   *  provider when per-tenant identity is off / the role isn't provisioned yet. */
  inferenceForTenant: (tenant: string) => Promise<InferenceProvider>;
}

type Env = Record<string, string | undefined>;

export function providersFromEnv(env: Env = process.env): Providers {
  const region = env.REGION ?? "eu-west-2";

  const inferenceKind = env.INFERENCE_PROVIDER ?? "bedrock";
  const inference: InferenceProvider = (() => {
    switch (inferenceKind) {
      case "bedrock":
        return new BedrockInferenceProvider(env.MODEL_ID ?? "amazon.nova-lite-v1:0", region);
      case "ollama":
        return new OllamaInferenceProvider(env.OLLAMA_MODEL ?? "llama3.1", env.OLLAMA_HOST);
      default:
        throw new Error(`unknown INFERENCE_PROVIDER: ${env.INFERENCE_PROVIDER}`);
    }
  })();

  const sandbox: SandboxProvider = (() => {
    switch (env.SANDBOX_PROVIDER ?? "agentcore") {
      case "agentcore":
        return new AgentCoreSandboxProvider(
          env.CODE_INTERPRETER_ID ?? "aws.codeinterpreter.v1",
          region,
          env.AGENTCORE_ENDPOINT,
        );
      case "local":
        return new LocalSandboxProvider(); // ⚠ DEMO ONLY — runs code on host, no isolation
      default:
        throw new Error(`unknown SANDBOX_PROVIDER: ${env.SANDBOX_PROVIDER}`);
    }
  })();

  const guard: ContentGuard = env.GUARDRAIL_ID
    ? new BedrockContentGuard(env.GUARDRAIL_ID, env.GUARDRAIL_VERSION ?? "DRAFT", region)
    : new NoopContentGuard();

  const telemetry: TelemetrySink = (() => {
    switch (env.TELEMETRY ?? "console") {
      case "console":
        return new ConsoleTelemetrySink();
      case "otel":
        return new OtelTelemetrySink();
      default:
        throw new Error(`unknown TELEMETRY: ${env.TELEMETRY}`);
    }
  })();

  // gate defaults to open (noop) so direct loop consumers are unaffected; the
  // runtime opts into token auth + budget via GATE=local (ADR-0009). With
  // GATE_BUDGET_SOURCE=kube the per-tenant cap is read from each TenantInferenceProfile
  // claim's monthlyBudgetUsd (ADR-0013); GATE_BUDGET_USD is then the fallback default.
  // SPEND_STORE=dynamodb makes the monthly spend counter durable (survives restarts);
  // SPEND_TABLE_ENDPOINT → DynamoDB Local. Defaults to in-memory (lost on restart).
  const budgetSource = env.GATE_BUDGET_SOURCE === "kube" ? new KubeBudgetSource() : undefined;
  const spendStore: SpendStore =
    (env.SPEND_STORE ?? "memory") === "dynamodb"
      ? new DynamoSpendStore(env.SPEND_TABLE ?? "agent-os-budgets", region, env.SPEND_TABLE_ENDPOINT)
      : new InMemorySpendStore();
  const gate: Gate =
    (env.GATE ?? "noop") === "local"
      ? new LocalGate(env.GATE_BUDGET_USD, { source: budgetSource, spendStore })
      : new NoopGate();

  // authn (ADR-0015): AUTHN picks the identity adapter. Default tracks the old
  // behaviour — token auth under GATE=local, open otherwise — so existing wiring is
  // unchanged; AUTHN=mesh trusts edge-verified claims (Istio/IAP), simulated locally.
  const authnKind = env.AUTHN ?? ((env.GATE ?? "noop") === "local" ? "token" : "noop");
  const authenticator: Authenticator = (() => {
    switch (authnKind) {
      case "token":
        return new StaticTokenAuthenticator(env.GATE_TOKENS);
      case "mesh":
        return new MeshTrustAuthenticator({
          header: env.MESH_IDENTITY_HEADER,
          tenantClaim: env.MESH_TENANT_CLAIM,
          groupsClaim: env.MESH_GROUPS_CLAIM,
        });
      case "noop":
        return new NoopAuthenticator();
      default:
        throw new Error(`unknown AUTHN: ${env.AUTHN}`);
    }
  })();

  // authz (ADR-0015): allow/deny policy seam. AllowAll stub today; OpaAuthorizer next.
  const authorizer: Authorizer = new AllowAllAuthorizer();

  // per-tenant workload identity (ADR-0014): TENANT_ASSUME_ROLE=kube makes the runtime
  // assume each tenant's IAM role (agentos-<tenant>, ARN from the claim) per run, so
  // calls act AS the tenant. Bedrock-only (it's the AWS-cred injection point); other
  // providers ignore it and use the shared instance.
  const tenantCredentials: TenantCredentials | undefined =
    env.TENANT_ASSUME_ROLE === "kube" && inferenceKind === "bedrock"
      ? new KubeStsTenantCredentials(region)
      : undefined;
  const inferenceForTenant = async (tenant: string): Promise<InferenceProvider> => {
    if (!tenantCredentials) return inference;
    const creds = await tenantCredentials.forTenant(tenant);
    return creds ? new BedrockInferenceProvider(inference.model, region, creds) : inference;
  };

  // credential broker defaults to deny-all (noop); authenticated tools are inert
  // until CRED_BROKER=local grants downstream targets per tenant (ADR-0010).
  const credentials: CredentialBroker =
    (env.CRED_BROKER ?? "noop") === "local" ? new LocalCredentialBroker(env.CRED_BROKER_CONFIG) : new NoopCredentialBroker();

  // tool gateway (ADR-0011): built-in tools always; MCP servers added when
  // MCP_SERVERS is configured. The runtime resolves a per-run toolset through it.
  const toolProvider: ToolProvider = (() => {
    const providers: ToolProvider[] = [new BuiltinToolProvider(credentials)];
    const mcpServers: McpServers = env.MCP_SERVERS ? JSON.parse(env.MCP_SERVERS) : {};
    if (Object.keys(mcpServers).length) providers.push(new McpToolProvider(mcpServers, credentials));
    return new CompositeToolProvider(providers);
  })();

  // remember (State primitive): durable run store. In-memory for dev; DynamoDB
  // (a real AWS resource) for restart-survival. RUNS_TABLE_ENDPOINT → DynamoDB Local.
  const runStore: RunStore =
    (env.RUN_STORE ?? "memory") === "dynamodb"
      ? new DynamoDBRunStore(env.RUNS_TABLE ?? "agent-os-runs", region, env.RUNS_TABLE_ENDPOINT)
      : new InMemoryRunStore();

  // agent control plane (#5): the registry of agent definitions the runtime reads.
  // memory (seeded from AGENTS_JSON) for dev; kube reads Agent CRs (ADR-0012).
  const agentRegistry: AgentRegistry = (() => {
    switch (env.AGENT_REGISTRY ?? "memory") {
      case "memory":
        return new InMemoryAgentRegistry(env.AGENTS_JSON ? (JSON.parse(env.AGENTS_JSON) as AgentSpec[]) : []);
      case "kube":
        return new KubeAgentRegistry(env.AGENTS_NAMESPACE ?? "agent-os");
      default:
        throw new Error(`unknown AGENT_REGISTRY: ${env.AGENT_REGISTRY}`);
    }
  })();

  return { inference, sandbox, guard, telemetry, gate, authenticator, authorizer, credentials, toolProvider, runStore, agentRegistry, inferenceForTenant };
}
