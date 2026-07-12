import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

/**
 * AgentCoreStack — the managed profile's loop hosting (ADR-0042, phase 1): the
 * SAME agent-runtime image the serverless profile runs on Fargate, hosted as an
 * AgentCore Runtime instead — one microVM session per run, scale-to-zero,
 * active-CPU billing (LLM-wait is typically free, vs Fargate's wall-clock).
 *
 * What leans in here is HOSTING only. The run's providers are the same cheap-
 * profile bundle (DynamoDB stores, Bedrock think, Code Interpreter sandbox), the
 * gate stays at the front door, and the router still creates the queued Run —
 * it just dispatches via InvokeAgentRuntime (DISPATCH=agentcore) instead of
 * ecs:RunTask. The claude-code lane deliberately stays on Fargate (§15 of the
 * service comparison: no sidecar seat, hard 2vCPU/8GB, no domain egress).
 *
 * Image trick: CfnRuntime has NO command override, so the Dockerfile's CMD is
 * shell-form over RUNTIME_ENTRYPOINT and this stack selects the agentcore.ts
 * entrypoint via an environment variable. Same DockerImageAsset parameters as
 * ServerlessStack ⇒ same content hash ⇒ the ONE image is built and pushed once.
 *
 * Envelope accepted (ADR-0042): ≤8h sessions, ≤2vCPU/8GB — fine for the loop,
 * whose heavy work (think, do) is remote. idleRuntimeSessionTimeout is tuned
 * LOW because sessions are per-run: once the run finishes the session is idle
 * garbage, and memory GB-hours bill across idle time within a session.
 */
export class AgentCoreStack extends cdk.Stack {
  /** What the router needs to dispatch here (AGENTCORE_RUNTIME_ARN). */
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Same asset parameters as ServerlessStack's image ⇒ same hash ⇒ no second build.
    const image = new ecrAssets.DockerImageAsset(this, "Image", {
      directory: path.join(__dirname, "..", ".."),
      file: "services/agent-runtime/Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    // Reuse the durable stores from StateStack (imported by name — no new tables).
    const runs = dynamodb.Table.fromTableName(this, "RunsTable", "agent-os-runs");
    const budgets = dynamodb.Table.fromTableName(this, "BudgetsTable", "agent-os-budgets");
    const agents = dynamodb.Table.fromTableName(this, "AgentsTable", "agent-os-agents");

    // The session's cloud identity — the same least-privilege set as the Fargate
    // task role (ADR-0031), assumed by the AgentCore service instead of ECS.
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      roleName: "agent-os-agentcore-runtime",
      description: "agent-os loop on AgentCore Runtime - runs+budgets tables, Bedrock invoke, Code Interpreter",
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
    });
    runs.grantReadWriteData(runtimeRole); // persist conversation/status per turn
    budgets.grantReadWriteData(runtimeRole); // durable per-turn spend (SPEND_STORE=dynamodb)
    agents.grantReadData(runtimeRole); // resolve the named agent's spec (read-only)
    runtimeRole.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyName(this, "BedrockInvoke", "agent-os-bedrock-invoke"),
    );
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AgentCoreCodeInterpreter",
        actions: [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:InvokeCodeInterpreter",
          "bedrock-agentcore:StopCodeInterpreterSession",
        ],
        resources: ["*"],
      }),
    );
    // Runtime writes its own service logs/telemetry to CloudWatch on our behalf.
    runtimeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogs",
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"],
        resources: ["*"],
      }),
    );

    const runtime = new agentcore.CfnRuntime(this, "Runtime", {
      agentRuntimeName: "agent_os_runtime", // pattern forbids dashes
      description: "agent-os L1 loop on AgentCore Runtime - session-per-run (ADR-0042 phase 1)",
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      roleArn: runtimeRole.roleArn,
      // PUBLIC egress matches the no-NAT cheap posture: the loop talks out to
      // DynamoDB/Bedrock/AgentCore over public AWS APIs, nothing dials in except
      // InvokeAgentRuntime. VPC mode is the graduation when egress must be walled.
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      // Sessions are per-run: after the run finishes the session is idle garbage,
      // and memory GB-hours bill across in-session idle — reap fast (60s, vs the
      // 15-min default). maxLifetime stays the 8h ceiling for long runs.
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 60 },
      environmentVariables: {
        // the CMD selector (no command override on CfnRuntime — see the Dockerfile)
        RUNTIME_ENTRYPOINT: "services/agent-runtime/agentcore.ts",
        PORT: "8080", // Runtime's HTTP contract port
        REGION: this.region,
        // the SAME cheap-profile adapter bundle as the Fargate executor (ADR-0031):
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        AGENT_REGISTRY: "dynamodb",
        AGENTS_TABLE: "agent-os-agents",
        GATE: "local",
        INFERENCE_PROVIDER: "bedrock",
        MODEL_ID: "amazon.nova-lite-v1:0",
        SANDBOX_PROVIDER: "agentcore",
        // TELEMETRY=otel without an endpoint = console exporter (spans → the
        // Runtime's CloudWatch logs). Grafana OTLP needs its auth header, which is
        // an SSM SecureString — CfnRuntime env vars are plaintext, so wiring that
        // in is a follow-up (fetch-at-start via SSM read), not a template value.
        TELEMETRY: "otel",
      },
    });

    this.runtimeArn = runtime.attrAgentRuntimeArn;

    new cdk.CfnOutput(this, "RuntimeArn", { value: runtime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "RuntimeId", { value: runtime.attrAgentRuntimeId });
    new cdk.CfnOutput(this, "RuntimeRoleArn", { value: runtimeRole.roleArn });
  }
}
