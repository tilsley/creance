/**
 * The dispatch seam (ADR-0031) — how a freshly-created, queued Run gets executed.
 * This is the ONE place the two substrates diverge:
 *   - inprocess: the always-on service runs the worker itself, fire-and-forget
 *     (full-k8s); the run shares the front door's process.
 *   - runtask:   the front door (router) launches a Fargate task-per-run that
 *     executes this run and exits (serverless / scale-to-zero). The router holds
 *     no run — it created the queued record and handed off.
 * Selected by DISPATCH (default inprocess), so server.ts is the front door in
 * both profiles; only the env bundle changes (ADR-0027).
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

/** Pick the dispatch impl by env (DISPATCH=inprocess|runtask; default inprocess). */
export function dispatchFromEnv(providers: Providers, opts: ProcessRunOpts = {}): Dispatch {
  const mode = process.env.DISPATCH ?? "inprocess";
  switch (mode) {
    case "inprocess":
      return inProcessDispatch(providers, opts);
    case "runtask":
      return runTaskDispatch(runTaskConfigFromEnv(), providers.runStore, providers.agentRegistry);
    default:
      throw new Error(`unknown DISPATCH: ${mode} (expected inprocess|runtask)`);
  }
}
