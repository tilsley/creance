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
import { type Providers, type Run, type RunStore } from "@agent-os/core";
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
  };
}

/** serverless: launch a Fargate task-per-run that executes this run and exits
 *  (ADR-0031). The run id rides in as a RUN_ID container override, so one task
 *  def serves every run. On a dispatch failure the run can't silently rot in
 *  `queued` — mark it failed so the poller sees a terminal state. */
export function runTaskDispatch(config: RunTaskConfig, runStore: RunStore): Dispatch {
  const ecs = new ECSClient({ region: config.region ?? process.env.REGION ?? "eu-west-2" });
  return (run) => {
    ecs
      .send(
        new RunTaskCommand({
          cluster: config.cluster,
          taskDefinition: config.taskDefinition,
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
            containerOverrides: [{ name: config.container, environment: [{ name: "RUN_ID", value: run.id }] }],
          },
        }),
      )
      .then((res) => {
        const failures = res.failures ?? [];
        if (failures.length) throw new Error(`RunTask failures: ${JSON.stringify(failures)}`);
        console.log(`dispatched run ${run.id} -> ${res.tasks?.[0]?.taskArn ?? "(task)"}`);
      })
      .catch(async (e) => {
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
      return runTaskDispatch(runTaskConfigFromEnv(), providers.runStore);
    default:
      throw new Error(`unknown DISPATCH: ${mode} (expected inprocess|runtask)`);
  }
}
