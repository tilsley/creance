/**
 * The ports/adapters seam as config (ADR-0003): build the four building blocks
 * from environment variables. Shared by the example CLI and the services so
 * there's one wiring, not a copy per consumer.
 *
 * Call ONCE per process — the OTel telemetry sink registers a global provider.
 */
import { BedrockInferenceProvider } from "./adapters/bedrock-inference";
import { OllamaInferenceProvider } from "./adapters/ollama-inference";
import { ScriptedInferenceProvider } from "./adapters/scripted-inference";
import { AdmissionInferenceProvider } from "./adapters/admission-inference";
import { GatewayInferenceProvider } from "./adapters/gateway-inference";
import { AgentCoreSandboxProvider } from "./adapters/agentcore-sandbox";
import { E2BSandboxProvider } from "./adapters/e2b-sandbox";
import { LocalSandboxProvider } from "./adapters/local-sandbox";
import { BedrockContentGuard } from "./adapters/bedrock-guard";
import { NoopContentGuard } from "./adapters/noop-guard";
import { ConsoleTelemetrySink } from "./adapters/console-telemetry";
import { OtelTelemetrySink } from "./adapters/otel-telemetry";
import { LocalGate } from "./adapters/local-gate";
import { NoopGate } from "./adapters/noop-gate";
import { StaticTokenAuthenticator } from "./adapters/static-token-authenticator";
import { MeshTrustAuthenticator } from "./adapters/mesh-trust-authenticator";
import { OidcServiceAccountAuthenticator, KubeTokenReviewer } from "./adapters/oidc-sa-authenticator";
import { NoopAuthenticator } from "./adapters/noop-authenticator";
import { AllowAllAuthorizer } from "./adapters/allow-all-authorizer";
import { OpaAuthorizer } from "./adapters/opa-authorizer";
import { KubeClaimSource } from "./adapters/kube-claim-source";
import { DynamoClaimSource } from "./adapters/dynamo-claim-source";
import type { ClaimSource, ClaimWrite } from "./claims";
import { DynamoSpendStore } from "./adapters/dynamo-spend-store";
import { InMemorySpendStore, type SpendStore } from "./gate";
import { KubeStsTenantCredentials, type TenantCredentials } from "./adapters/sts-tenant-credentials";
import { LocalCredentialBroker } from "./adapters/local-credential-broker";
import { NoopCredentialBroker } from "./adapters/noop-credential-broker";
import { OboTokenVaultBroker } from "./adapters/obo-token-vault-broker";
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
  inferenceForTenant: (tenant: string, token?: string, scopeId?: string, model?: string) => Promise<InferenceProvider>;
  /** The claim reader (ADR-0021), when configured — lets the gateway route per-claim model. */
  claimSource?: ClaimSource;
  /** Self-service write deps for `POST /claims` (tenant = identity, 1:1), when the dynamo write
   *  path + an identity verifier are configured. */
  claimWrite?: ClaimWrite;
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
      case "scripted": // deterministic demo/test driver (ADR-0017 A2A); SCRIPTED_TURNS = JSON
        return new ScriptedInferenceProvider(env.SCRIPTED_TURNS ? JSON.parse(env.SCRIPTED_TURNS) : []);
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
      case "e2b": // remote Firecracker microVM per session (ADR-0019); needs E2B_API_KEY
        return new E2BSandboxProvider({ apiKey: env.E2B_API_KEY, template: env.E2B_TEMPLATE });
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
  // TENANT_CLAIM_* overrides the CRD the SA->tenant binding + cap are read from — e.g. a
  // standalone binding CRD where the canonical TenantInferenceProfile is Crossplane-owned
  // (and would otherwise try to provision). Defaults to the TenantInferenceProfile claim.
  const claimCrd = env.TENANT_CLAIM_PLURAL
    ? {
        group: env.TENANT_CLAIM_GROUP,
        version: env.TENANT_CLAIM_VERSION,
        plural: env.TENANT_CLAIM_PLURAL,
        scope: env.TENANT_CLAIM_SCOPE === "Namespaced" ? ("Namespaced" as const) : ("Cluster" as const),
      }
    : undefined;
  // ONE claim reader (ADR-0021) serves both the gate's budget cap and the authn SA→tenant
  // resolver — built only when something needs it (kube budget source or oidc-sa authn).
  // CLAIM_SOURCE picks where grants are read from (ADR-0021): kube (CRD, default) or dynamo (a
  // table, for non-k8s tenants — next to the spend counter). Built only when something needs it.
  const needClaims = env.GATE_BUDGET_SOURCE === "kube" || env.AUTHN === "oidc-sa";
  const claimSource = !needClaims
    ? undefined
    : env.CLAIM_SOURCE === "dynamo"
      ? new DynamoClaimSource(env.CLAIMS_TABLE ?? "agent-os-claims", { region, endpoint: env.CLAIMS_TABLE_ENDPOINT })
      : new KubeClaimSource(claimCrd);
  const budgetSource = env.GATE_BUDGET_SOURCE === "kube" ? claimSource : undefined;
  // identity verifier (shared by oidc-sa authn + the POST /claims write): TokenReview the SA token.
  const reviewer = env.AUTHN === "oidc-sa" ? new KubeTokenReviewer(env.OIDC_SA_AUDIENCE) : undefined;
  // self-service write (ADR-0021, tenant=identity 1:1): enabled for the dynamo claim store when an
  // identity verifier + a default allowance (CLAIMS_DEFAULT_MAX_USD) are present.
  const claimWrite: ClaimWrite | undefined =
    env.CLAIM_SOURCE === "dynamo" && reviewer && env.CLAIMS_DEFAULT_MAX_USD && claimSource instanceof DynamoClaimSource
      ? {
          verifyIdentity: async (token) => {
            const r = await reviewer.review(token);
            return r.authenticated && r.username?.startsWith("system:serviceaccount:") ? r.username : undefined;
          },
          allowance: {
            maxMonthlyUsd: Number(env.CLAIMS_DEFAULT_MAX_USD),
            allowedModels: (env.CLAIMS_ALLOWED_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          },
          putClaim: (claim) => (claimSource as DynamoClaimSource).putClaim(claim),
        }
      : undefined;
  const spendStore: SpendStore =
    (env.SPEND_STORE ?? "memory") === "dynamodb"
      ? new DynamoSpendStore(env.SPEND_TABLE ?? "agent-os-budgets", region, env.SPEND_TABLE_ENDPOINT)
      : new InMemorySpendStore();
  // GATE_SESSION_BUDGET_USD adds a per-session cap alongside the monthly one — the
  // runaway-session stop (ADR-0019). Unset ⇒ only the tenant/month cap is enforced.
  const sessionLimitUsd = env.GATE_SESSION_BUDGET_USD ? Number(env.GATE_SESSION_BUDGET_USD) : undefined;
  const gate: Gate =
    (env.GATE ?? "noop") === "local"
      ? new LocalGate(env.GATE_BUDGET_USD, { source: budgetSource, spendStore, sessionLimitUsd })
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
      case "oidc-sa":
        // verified workload identity (ADR-0019): TokenReview-validate the caller's
        // ServiceAccount token; tenant comes from the SA→claim binding, not the token.
        return new OidcServiceAccountAuthenticator({ audience: env.OIDC_SA_AUDIENCE, resolver: claimSource, reviewer });
      case "noop":
        return new NoopAuthenticator();
      default:
        throw new Error(`unknown AUTHN: ${env.AUTHN}`);
    }
  })();

  // authz (ADR-0015): allow/deny policy seam. AUTHZ=opa delegates to an OPA instance
  // (the user's org model — policy in Rego, owned per service); default AllowAll stub.
  const authorizer: Authorizer =
    env.AUTHZ === "opa"
      ? new OpaAuthorizer(env.OPA_URL ?? "http://localhost:8181/v1/data/agentos/authz")
      : new AllowAllAuthorizer();

  // per-tenant workload identity (ADR-0014): TENANT_ASSUME_ROLE=kube makes the runtime
  // assume each tenant's IAM role (agentos-<tenant>, ARN from the claim) per run, so
  // calls act AS the tenant. Bedrock-only (it's the AWS-cred injection point); other
  // providers ignore it and use the shared instance.
  const tenantCredentials: TenantCredentials | undefined =
    env.TENANT_ASSUME_ROLE === "kube" && inferenceKind === "bedrock"
      ? new KubeStsTenantCredentials(region)
      : undefined;
  // INFERENCE_GATEWAY_URL set ⇒ this process is a gateway CLIENT: forward generate over
  // HTTP to the standalone gateway (ADR-0019). It then holds no model creds and does no
  // local budget admission — the gateway enforces both. Unset ⇒ DIRECT: assume the
  // tenant's role, call Bedrock, and wrap with the worst-case budget admission here
  // (ADR-0013), so admission always runs wherever the *real* model call happens.
  const gatewayUrl = env.INFERENCE_GATEWAY_URL;
  const inferenceForTenant = async (tenant: string, token?: string, scopeId?: string, model?: string): Promise<InferenceProvider> => {
    // gateway-client: the gateway resolves the claim's model server-side; the client doesn't pick.
    if (gatewayUrl) return new GatewayInferenceProvider(gatewayUrl, inference.model, { token, tenant, sessionId: scopeId });
    // direct: route to the claim's model (ADR-0021) when given — Bedrock only; scripted/ollama ignore it.
    const creds = tenantCredentials ? await tenantCredentials.forTenant(tenant) : undefined;
    const base = creds
      ? new BedrockInferenceProvider(model ?? inference.model, region, creds)
      : model && inferenceKind === "bedrock"
        ? new BedrockInferenceProvider(model, region)
        : inference;
    return new AdmissionInferenceProvider(base, gate, tenant, scopeId);
  };

  // credential broker defaults to deny-all (noop). CRED_BROKER=local grants static
  // per-tenant service-account creds; CRED_BROKER=vault exchanges the caller's token
  // for downstream creds that act AS the user (OBO, RFC 8693 — ADR-0010).
  const credentials: CredentialBroker = (() => {
    switch (env.CRED_BROKER ?? "noop") {
      case "local":
        return new LocalCredentialBroker(env.CRED_BROKER_CONFIG);
      case "vault":
        // OBO_ACTOR = this runtime's agent identity, carried into the act claim (A2A chain)
        return new OboTokenVaultBroker(env.CRED_BROKER_CONFIG, env.OBO_ACTOR ?? "agent-os");
      default:
        return new NoopCredentialBroker();
    }
  })();

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

  return { inference, sandbox, guard, telemetry, gate, authenticator, authorizer, credentials, toolProvider, runStore, agentRegistry, inferenceForTenant, claimSource, claimWrite };
}
