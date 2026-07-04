import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * ServerlessStack — the cheap-profile compute substrate for the agent run loop
 * (ADR-0031): the loop runs as a **Fargate task-per-run**, not on always-on EKS.
 * This stack provisions the executor half + the dispatch contract the front door
 * (the router, DISPATCH=runtask) consumes. It REUSES StateStack's DynamoDB tables
 * and BedrockStack's invoke policy — no duplication.
 *
 * Cost shape (the whole point): no NAT gateway and no ALB. Tasks run in PUBLIC
 * subnets with a public IP so they reach Bedrock / DynamoDB / ECR directly; the
 * cluster holds zero running tasks at rest. Idle cost ≈ log retention ≈ $0. A run
 * costs only for the seconds its task is alive.
 *
 * The agent-runtime image is a **CDK DockerImageAsset**: `cdk deploy` builds it and
 * pushes it to the CDK-managed assets ECR repo, then BOTH the Fargate task and the
 * Lambda reference that one image (different CMDs). So the whole thing — image build,
 * push, and every resource — is one `cdk deploy`; no manual docker push, no repo to
 * manage. (Trade-off: deploy needs Docker running, since it builds the image.)
 *
 * What's deployed:
 *   - the agent-runtime image (DockerImageAsset — built + pushed by CDK).
 *   - a minimal public VPC + Fargate cluster + a task security group (egress only).
 *   - the executor task definition: the image with the task.ts CMD, RUN_ID injected
 *     per run via a container override at RunTask time.
 *   - a least-privilege task role (runs+budgets tables, Bedrock invoke, AgentCore).
 *   - a router role: ecs:RunTask + iam:PassRole — what the front door assumes to
 *     dispatch a task-per-run, plus tables access for create + budget checks.
 *   - the front-door COMPUTE: a Lambda (the SAME image, lambda.ts CMD → a native
 *     Runtime API loop, no HTTP server / no Web Adapter) with a Function URL. It
 *     runs the router (DISPATCH=runtask) and dispatches Fargate tasks. This is the
 *     always-reachable half; it too scales to zero (no idle cost between requests).
 *
 * You can also run the router locally against this stack instead of the Lambda:
 * assume AgentOsServerlessRouterRole, export the ECS_* outputs, and
 * `DISPATCH=runtask bun run services/agent-runtime/server.ts`.
 */
export class ServerlessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Optional demo bearer tokens for the front door's LocalGate, injected at deploy
    // (`-c gateTokens=...`) so nothing static is committed. See the FrontDoor env below.
    const gateTokens = this.node.tryGetContext("gateTokens");

    // The agent-runtime image, built + pushed by CDK at deploy time (one image, three
    // entrypoints: server.ts / task.ts / lambda.ts — the consumer picks via CMD). The
    // build context is the repo root (the Dockerfile's `COPY . .`); .dockerignore there
    // strips node_modules/.git/venvs. x86_64 to match the Intel build host (native, no
    // QEMU); switch to LINUX_ARM64 + arm64 task/Lambda when building on Graviton.
    const image = new ecrAssets.DockerImageAsset(this, "Image", {
      directory: path.join(__dirname, "..", ".."),
      file: "services/agent-runtime/Dockerfile",
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    // Minimal public VPC: 2 AZs, public subnets only, NO NAT gateway (~$32/mo
    // saved). Tasks get a public IP and egress straight to AWS APIs.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: "agent-os-serverless",
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED, // POC: skip the CloudWatch cost
    });

    // Egress-only SG for the task ENI (talks out to Bedrock/DynamoDB/ECR; nothing
    // dials in — the task is not a server).
    const taskSg = new ec2.SecurityGroup(this, "TaskSg", {
      vpc,
      description: "agent-os serverless task-per-run - egress only",
      allowAllOutbound: true,
    });

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/agent-os/serverless",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Reuse the durable stores from StateStack (imported by name — no new tables).
    const runs = dynamodb.Table.fromTableName(this, "RunsTable", "agent-os-runs");
    const budgets = dynamodb.Table.fromTableName(this, "BudgetsTable", "agent-os-budgets");

    // The task's cloud identity — least privilege for what a run actually does.
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: "agent-os-serverless-task",
      description: "agent-os task-per-run - runs+budgets tables, Bedrock invoke, AgentCore sandbox",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    runs.grantReadWriteData(taskRole); // persist conversation/status per turn
    budgets.grantReadWriteData(taskRole); // durable per-turn spend (SPEND_STORE=dynamodb)
    // Bedrock invoke — reuse BedrockStack's scoped managed policy (specific models +
    // ApplyGuardrail), not a fresh "bedrock:*".
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromManagedPolicyName(this, "BedrockInvoke", "agent-os-bedrock-invoke"),
    );
    // AgentCore Code Interpreter sandbox — exactly the 3 commands the adapter calls.
    // Resource "*": the built-in interpreter is AWS-owned; scope to a specific
    // code-interpreter ARN once a custom one is used.
    taskRole.addToPolicy(
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

    // The executor task def. cpu/mem sized for the loop (think is remote; the
    // sandbox is AgentCore, also remote) — small is fine.
    const taskDef = new ecs.FargateTaskDefinition(this, "ExecutorTaskDef", {
      family: "agent-os-runtime-task",
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      // x86_64 (the default): the image builds natively on the Intel build host, no
      // QEMU emulation. arm64/Graviton would be ~cheaper at runtime but needs an arm64
      // builder; revisit if building on Apple Silicon or in CI with buildx.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDef.addContainer("agent-runtime-task", {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      command: ["bun", "run", "services/agent-runtime/task.ts"], // the task-per-run entrypoint
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: "task" }),
      environment: {
        // RUN_ID is injected per run via a RunTask container override (not here).
        REGION: this.region,
        // serverless / cheap-profile adapter bundle (ADR-0027/0031):
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        GATE: "local",
        INFERENCE_PROVIDER: "bedrock",
        MODEL_ID: "amazon.nova-lite-v1:0",
        SANDBOX_PROVIDER: "agentcore",
        RECORD: "otel", // emit spans; harmless if no collector is set
      },
    });

    // The router's identity (the front door). It does NOT run loops — it dispatches
    // them: create the queued Run, then ecs:RunTask the executor, passing the task +
    // execution roles. Attach this to the Lambda/Fargate that serves POST /runs.
    const routerRole = new iam.Role(this, "RouterRole", {
      roleName: "agent-os-serverless-router",
      description: "agent-os serverless front door - ecs:RunTask + PassRole + tables",
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("lambda.amazonaws.com"),
        new iam.ServicePrincipal("ecs-tasks.amazonaws.com"), // if fronted by a Fargate service
        new iam.AccountRootPrincipal(), // run the router locally against this stack
      ),
    });
    runs.grantReadWriteData(routerRole); // create queued Run + serve GET /runs/{id} polling
    budgets.grantReadData(routerRole); // gate.checkBudget before admitting a run
    routerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DispatchRunTask",
        actions: ["ecs:RunTask"],
        // allow any revision of this family, so a redeploy doesn't break dispatch
        resources: [
          `arn:aws:ecs:${this.region}:${this.account}:task-definition/${taskDef.family}:*`,
        ],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    routerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassTaskRoles",
        actions: ["iam:PassRole"],
        resources: [taskRole.roleArn, taskDef.executionRole!.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );
    // We supply the router role, so CDK won't auto-attach Lambda's log permissions.
    routerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
    );

    // The front door — the SAME image asset, the lambda.ts entrypoint (a native Lambda
    // Runtime API loop; no HTTP server, no Web Adapter — ADR-0031). It runs the router:
    // DISPATCH=runtask makes POST /runs launch a Fargate task-per-run. NOT in the VPC —
    // it reaches DynamoDB + ecs:RunTask over public AWS APIs, so it needs no NAT (idle
    // cost ~$0). It scales to zero between requests. Referencing the asset's repo+tag
    // (not fromImageAsset) reuses the ONE build the task already uses — no second build.
    const frontDoor = new lambda.DockerImageFunction(this, "FrontDoor", {
      functionName: "agent-os-serverless-router",
      description: "agent-os serverless front door - gate + dispatch a Fargate task-per-run (ADR-0031)",
      code: lambda.DockerImageCode.fromEcr(image.repository, {
        tagOrDigest: image.imageTag,
        cmd: ["bun", "run", "services/agent-runtime/lambda.ts"], // the Runtime API loop
      }),
      architecture: lambda.Architecture.X86_64, // match the x86_64 image asset (native Intel build)
      role: routerRole,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30), // gate + RunTask is quick; the run itself is the task's life
      logGroup,
      environment: {
        REGION: this.region,
        DISPATCH: "runtask", // the serverless seam: dispatch a task-per-run (dispatch.ts)
        // the RunTask wiring dispatch.ts reads (runTaskConfigFromEnv):
        ECS_CLUSTER: cluster.clusterName,
        ECS_TASK_DEFINITION: taskDef.family,
        ECS_CONTAINER_NAME: "agent-runtime-task",
        ECS_SUBNETS: cdk.Fn.join(",", vpc.publicSubnets.map((s) => s.subnetId)),
        ECS_SECURITY_GROUPS: taskSg.securityGroupId,
        ECS_ASSIGN_PUBLIC_IP: "true", // public subnets, no NAT
        // the front door's own adapter bundle: durable stores + offline gate. It does
        // NOT run the loop, so inference/sandbox default and stay unused (no network).
        RUN_STORE: "dynamodb",
        RUNS_TABLE: "agent-os-runs",
        SPEND_STORE: "dynamodb",
        SPEND_TABLE: "agent-os-budgets",
        GATE: "local", // authn (bearer) + budget admission at the door (ADR-0009/0013)
        // Static demo tokens (LocalGate is dev-only) injected at deploy via context, NOT
        // committed: `-c gateTokens="tok:tenant:subject,..."`. Unset ⇒ every request 401s
        // (safe default). Real deploys swap LocalGate for keyless authn (mesh/OIDC).
        ...(gateTokens ? { GATE_TOKENS: String(gateTokens) } : {}),
      },
    });

    // Public Function URL — auth is enforced at the APP layer by the gate (GATE=local
    // bearer + budget), so the URL itself is open (POC). Swap to AWS_IAM to require
    // SigV4 in front of the app gate.
    const fnUrl = frontDoor.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // The front door's env contract — wire these into the router (DISPATCH=runtask).
    new cdk.CfnOutput(this, "FrontDoorFunctionName", { value: frontDoor.functionName });
    new cdk.CfnOutput(this, "FrontDoorUrl", { value: fnUrl.url });
    new cdk.CfnOutput(this, "EcsCluster", { value: cluster.clusterName });
    new cdk.CfnOutput(this, "EcsTaskDefinition", { value: taskDef.family });
    new cdk.CfnOutput(this, "EcsContainerName", { value: "agent-runtime-task" });
    new cdk.CfnOutput(this, "EcsSubnets", {
      value: cdk.Fn.join(",", vpc.publicSubnets.map((s) => s.subnetId)),
    });
    new cdk.CfnOutput(this, "EcsSecurityGroups", { value: taskSg.securityGroupId });
    new cdk.CfnOutput(this, "EcsAssignPublicIp", { value: "true" }); // public subnets, no NAT
    new cdk.CfnOutput(this, "RouterRoleArn", { value: routerRole.roleArn });
    new cdk.CfnOutput(this, "TaskRoleArn", { value: taskRole.roleArn });
  }
}
