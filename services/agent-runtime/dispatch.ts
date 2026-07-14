/**
 * The dispatch seam (ADR-0031) — how a freshly-created, queued Run gets executed.
 * This is the ONE place the two substrates diverge:
 *   - inprocess: the always-on service runs the worker itself, fire-and-forget
 *     (full-k8s); the run shares the front door's process.
 *   - runtask:   the front door (router) launches a Fargate task-per-run that
 *     executes this run and exits (serverless / scale-to-zero). The router holds
 *     no run — it created the queued record and handed off.
 *   - agentengine: the front door invokes a GCP Vertex **Agent Runtime**
 *     (reasoningEngine :query) with the runId — the managed-runtime analog of
 *     runtask, and the GCP sibling of ADR-0042's DISPATCH=agentcore. The run
 *     executes inside the managed container (agent-engine.ts); state lives in the
 *     store; the poller watches it. Fire-and-forget, like the others.
 * Selected by DISPATCH (default inprocess), so server.ts is the front door in
 * every profile; only the env bundle changes (ADR-0027).
 */
import { type AgentRegistry, type Providers, type Run, type RunStore } from "@agent-os/core";
import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { processRun, type ProcessRunOpts } from "./process-run";

export type Dispatch = (run: Run) => void;

/** full-k8s: execute the run in this process, fire-and-forget. processRun owns its
 *  own failures (it persists status=failed), so a rejection here is truly unexpected. */
export function inProcessDispatch(providers: Providers, opts: ProcessRunOpts = {}): Dispatch {
  return (run) => {
    void processRun(providers, run.id, opts).catch((e) =>
      console.error(`in-process worker crashed for run ${run.id}: ${e?.message ?? e}`),
    );
  };
}

export interface RunTaskConfig {
  cluster: string;
  taskDefinition: string;
  /** The container in the task def to inject RUN_ID into (matches the CDK task def). */
  container: string;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: boolean;
  region?: string;
  /** The kind="claude-code" executor (ADR-0033): a different task def in the SAME
   *  cluster/subnets, same RUN_ID-override contract. Unset ⇒ claude-code runs fail
   *  at dispatch (terminal, visible to the poller) rather than mis-running on the loop.
   *  sidecarContainer (ADR-0034): the egress sidecar also receives RUN_ID so it can
   *  resolve its own per-run credential allowlist from the registry. */
  claudeCode?: { taskDefinition: string; container: string; sidecarContainer?: string };
}

/** Read the RunTask wiring the CDK stack publishes into the router's env. */
export function runTaskConfigFromEnv(env: Record<string, string | undefined> = process.env): RunTaskConfig {
  const req = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`DISPATCH=runtask requires ${k}`);
    return v;
  };
  const list = (k: string): string[] => req(k).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    cluster: req("ECS_CLUSTER"),
    taskDefinition: req("ECS_TASK_DEFINITION"),
    container: env.ECS_CONTAINER_NAME ?? "agent-runtime-task",
    subnets: list("ECS_SUBNETS"),
    securityGroups: list("ECS_SECURITY_GROUPS"),
    assignPublicIp: (env.ECS_ASSIGN_PUBLIC_IP ?? "false").toLowerCase() === "true",
    region: env.REGION,
    claudeCode: env.ECS_CC_TASK_DEFINITION
      ? {
          taskDefinition: env.ECS_CC_TASK_DEFINITION,
          container: env.ECS_CC_CONTAINER_NAME ?? "claude-code-runner",
          sidecarContainer: env.ECS_CC_SIDECAR_CONTAINER_NAME,
        }
      : undefined,
  };
}

/** serverless: launch a Fargate task-per-run that executes this run and exits
 *  (ADR-0031). The run id rides in as a RUN_ID container override, so one task
 *  def serves every run. kind="claude-code" agents (ADR-0033) route to their own
 *  task def — the registry lookup here is the ONLY fork; the launch contract is
 *  identical. On a dispatch failure the run can't silently rot in `queued` —
 *  mark it failed so the poller sees a terminal state. */
export function runTaskDispatch(
  config: RunTaskConfig,
  runStore: RunStore,
  agentRegistry?: AgentRegistry,
): Dispatch {
  const ecs = new ECSClient({ region: config.region ?? process.env.REGION ?? "eu-west-2" });
  return (run) => {
    void (async () => {
      let target: { taskDefinition: string; container: string; sidecarContainer?: string } = {
        taskDefinition: config.taskDefinition,
        container: config.container,
      };
      const spec = run.agent && agentRegistry ? await agentRegistry.get(run.agent) : undefined;
      if (spec?.kind === "claude-code") {
        if (!config.claudeCode)
          throw new Error(`agent '${run.agent}' is kind=claude-code but ECS_CC_TASK_DEFINITION is not configured`);
        target = config.claudeCode;
      }
      // RUN_ID reaches every listed container: the executor to run it, the egress
      // sidecar (ADR-0034) to resolve its per-run credential allowlist from the registry.
      const overrideContainers = [target.container, ...(target.sidecarContainer ? [target.sidecarContainer] : [])];
      const res = await ecs.send(
        new RunTaskCommand({
          cluster: config.cluster,
          taskDefinition: target.taskDefinition,
          launchType: "FARGATE",
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: config.subnets,
              securityGroups: config.securityGroups,
              assignPublicIp: config.assignPublicIp ? "ENABLED" : "DISABLED",
            },
          },
          overrides: {
            containerOverrides: overrideContainers.map((name) => ({
              name,
              environment: [{ name: "RUN_ID", value: run.id }],
            })),
          },
        }),
      );
      const failures = res.failures ?? [];
      if (failures.length) throw new Error(`RunTask failures: ${JSON.stringify(failures)}`);
      console.log(`dispatched run ${run.id} -> ${res.tasks?.[0]?.taskArn ?? "(task)"}`);
    })().catch(async (e) => {
      console.error(`RunTask dispatch failed for run ${run.id}: ${e?.message ?? e}`);
      await runStore
        .update(run.id, { status: "failed", error: `dispatch failed: ${e?.message ?? e}` })
        .catch(() => {});
    });
  };
}

export interface AgentEngineConfig {
  project: string;
  location: string;
  /** The deployed reasoningEngine's numeric id (Agent Runtime resource). */
  reasoningEngineId: string;
  /** Override the aiplatform base (defaults to the regional endpoint). */
  endpoint?: string;
}

/** Read the Agent Runtime wiring the deploy publishes into the front door's env. */
export function agentEngineConfigFromEnv(env: Record<string, string | undefined> = process.env): AgentEngineConfig {
  const req = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`DISPATCH=agentengine requires ${k}`);
    return v;
  };
  return {
    project: req("GCP_PROJECT"),
    location: env.GCP_LOCATION ?? "europe-west2",
    reasoningEngineId: req("AGENT_ENGINE_ID"),
    endpoint: env.AGENT_ENGINE_ENDPOINT,
  };
}

/** A GCP access token for the reasoningEngines call. Prefers an explicit
 *  GCP_ACCESS_TOKEN (local/testing); otherwise the instance metadata server (works
 *  when the front door runs on GCP — Cloud Run/GCE). Dependency-free on purpose:
 *  no google-cloud SDK in the shared runtime image. Cross-cloud (front door on AWS
 *  Lambda) will graduate to WIF here. */
async function gcpAccessToken(): Promise<string> {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`GCP metadata token fetch failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** managed GCP: invoke a Vertex Agent Runtime (reasoningEngine :query) with the
 *  runId (ADR-0042's GCP sibling). The run executes in the managed container; on a
 *  dispatch failure mark the run failed so it can't rot in `queued`. */
export function agentEngineDispatch(config: AgentEngineConfig, runStore: RunStore): Dispatch {
  const base = config.endpoint ?? `https://${config.location}-aiplatform.googleapis.com/v1`;
  const url = `${base}/projects/${config.project}/locations/${config.location}/reasoningEngines/${config.reasoningEngineId}:query`;
  return (run) => {
    void (async () => {
      const token = await gcpAccessToken();
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ input: { runId: run.id } }),
      });
      if (!res.ok) throw new Error(`reasoningEngine :query ${res.status}: ${await res.text()}`);
      console.log(`dispatched run ${run.id} -> reasoningEngine ${config.reasoningEngineId}`);
    })().catch(async (e) => {
      console.error(`agentengine dispatch failed for run ${run.id}: ${e?.message ?? e}`);
      await runStore.update(run.id, { status: "failed", error: `dispatch failed: ${e?.message ?? e}` }).catch(() => {});
    });
  };
}

/** Pick the dispatch impl by env (DISPATCH=inprocess|runtask|agentengine; default inprocess). */
export function dispatchFromEnv(providers: Providers, opts: ProcessRunOpts = {}): Dispatch {
  const mode = process.env.DISPATCH ?? "inprocess";
  switch (mode) {
    case "inprocess":
      return inProcessDispatch(providers, opts);
    case "runtask":
      return runTaskDispatch(runTaskConfigFromEnv(), providers.runStore, providers.agentRegistry);
    case "agentengine":
      return agentEngineDispatch(agentEngineConfigFromEnv(), providers.runStore);
    default:
      throw new Error(`unknown DISPATCH: ${mode} (expected inprocess|runtask|agentengine)`);
  }
}
