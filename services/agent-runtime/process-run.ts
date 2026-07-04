/**
 * The worker body — execute one queued Run to a terminal state, persisting
 * conversation + status each turn and accounting its spend.
 *
 * Extracted from server.ts so it has a single home shared by two substrates,
 * with a byte-identical run body either way (ADR-0031):
 *   - the always-on HTTP service runs it in-process, fire-and-forget (full-k8s);
 *   - the Fargate task-per-run (task.ts) runs it once and exits (serverless).
 * The substrates differ only in *who* invokes this and *when the process ends* —
 * not in what a run does. The router's job is upstream (authn → authz → budget →
 * create the queued Run); this is the part it dispatches.
 */
import {
  runOnSession,
  runSandboxedAgent,
  estimateCostUsd,
  type Providers,
} from "@agent-os/core";

export interface ProcessRunOpts {
  /** Per-turn output cap (ADR-0013); undefined -> the loop's built-in default. */
  maxOutputTokens?: number;
}

/** Execute a queued run, persisting state + accounting spend. No-op if the id is unknown. */
export async function processRun(
  providers: Providers,
  id: string,
  opts: ProcessRunOpts = {},
): Promise<void> {
  const { runStore: store, agentRegistry, toolProvider } = providers;
  const existing = await store.get(id);
  if (!existing) return;
  const principal = existing.principal ?? { tenant: "default", subject: "anonymous" };
  const tenant = principal.tenant;
  // agent control plane (#5): resolve the run's agent definition + apply it
  const spec = existing.agent ? await agentRegistry.get(existing.agent) : undefined;
  await store.update(id, { status: "running" });
  const session = await providers.sandbox.startSession();
  // resolve this run's toolset through the gateway (built-in + MCP servers,
  // per-tenant policy, broker creds injected; ADR-0011)
  const toolset = await toolProvider.resolve({ principal, session });
  try {
    let result;
    if (spec?.kind === "sandboxed") {
      // Model B (ADR-0019): a self-contained delegated agent runs IN the sandbox; its
      // inference egress is pointed at the gateway (think governed), its execution stays
      // in the sandbox (do governed). The gateway is its only sanctioned model egress.
      const gatewayUrl = process.env.INFERENCE_GATEWAY_URL;
      if (!gatewayUrl) throw new Error("sandboxed agents require INFERENCE_GATEWAY_URL (the gateway is their only sanctioned model egress)");
      result = await runSandboxedAgent({ session, task: existing.task, spec, gatewayUrl, token: principal.token, telemetry: providers.telemetry });
    } else {
      // Model A: the runtime drives the think/do loop. DIRECT mode assumes the tenant's
      // role + budget admission (ADR-0013/0014); GATEWAY mode (INFERENCE_GATEWAY_URL) is an
      // HTTP client to the standalone gateway — this runtime then holds no model creds
      // (ADR-0019). The caller token is forwarded so the gateway re-derives the tenant.
      const inference = await providers.inferenceForTenant(tenant, principal.token, id);
      result = await runOnSession({
        inference,
        guard: providers.guard,
        telemetry: providers.telemetry,
        session,
        task: existing.task,
        systemPrompt: spec?.systemPrompt,
        maxSteps: spec?.maxSteps,
        maxOutputTokens: opts.maxOutputTokens,
        tools: () => toolset.tools,
        onProgress: (messages) => {
          store.update(id, { messages }).catch(() => {}); // durable per-turn state
        },
      });
    }
    // spend is recorded per-turn by the admission decorator (or the gateway's session
    // counter for B); here we just persist the run's total cost for the run record.
    const costUsd = estimateCostUsd(providers.inference.model, result.usage);
    await store.update(id, { status: result.status, output: result.output, usage: result.usage, costUsd });
  } catch (e: any) {
    await store.update(id, { status: "failed", error: e?.message ?? String(e) });
  } finally {
    await toolset.close().catch(() => {});
    await session.close().catch(() => {});
  }
}
