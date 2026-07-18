/**
 * The front-door gate sequence (ADR-0015/0018), shared by REST POST /runs and A2A
 * message/send: authn → authz(target agent) → budget → create the queued Run →
 * dispatch. Extracted from server.ts so the *same* gate runs in both substrates
 * (ADR-0031); only `dispatch` differs — in-process worker (full-k8s) vs ECS
 * RunTask (serverless). The gate being identical is what keeps R1 (verified
 * identity) + R2 (real-time budget) invariant across profiles (ADR-0027).
 */
import { UnauthorizedError, type DispatchMode, type Providers, type Run } from "@agent-os/core";
import type { GateOutcome } from "./a2a";
import type { Dispatcher } from "./dispatch";

/** Build the gate handler over a set of providers and a dispatch strategy. */
export function makeAuthorizeAndCreate(providers: Providers, dispatcher: Dispatcher) {
  const { authenticator, authorizer, gate, agentRegistry, runStore: store } = providers;
  return async function authorizeAndCreate(
    credential: string | undefined,
    headers: Record<string, string>,
    agent: string | undefined,
    task: string,
    repo?: string,
    dispatchMode?: string,
  ): Promise<GateOutcome> {
    // The substrate is a caller-chosen, run-level resource (ADR-0042): validated
    // against what this deployment actually wires, stamped onto the run below.
    if (dispatchMode !== undefined && !dispatcher.modes.includes(dispatchMode as DispatchMode)) {
      return {
        ok: false,
        status: 400,
        error: `unknown dispatch '${dispatchMode}' (available: ${dispatcher.modes.join(", ")})`,
      };
    }
    let principal;
    try {
      principal = await authenticator.authenticate({ credential, headers });
    } catch (e) {
      if (e instanceof UnauthorizedError) return { ok: false, status: 401, error: "unauthorized" };
      throw e;
    }
    // repo is a caller-chosen RESOURCE (ADR-0034): the authorizer decides whether
    // this principal may target it (Rego under AUTHZ=opa; AllowAll in the POC).
    const decision = await authorizer.authorize(principal, "run:create", agent, repo ? { repo } : undefined);
    if (!decision.allow) return { ok: false, status: 403, error: "forbidden", reason: decision.reason };
    // Resolve the agent spec up front — its execution model picks the admission control.
    let spec;
    if (agent != null) {
      spec = await agentRegistry.get(agent);
      if (!spec) return { ok: false, status: 404, error: `unknown agent '${agent}'` };
    }
    // Admission control by execution model (ADR-0036): a foreign-L1 / subscription
    // run (kind=claude-code) has no meaningful dollar cost, so R2 is a per-period run
    // QUOTA reserved here; every other run is dollar-budget-gated as before.
    if (spec?.kind === "claude-code") {
      const quota = await gate.reserveRun(principal.tenant);
      if (!quota.ok)
        return { ok: false, status: 429, error: "run quota exhausted", reason: `${quota.used}/${quota.limit} claude-code runs this period` };
    } else {
      const budget = await gate.checkBudget(principal.tenant);
      if (!budget.ok) return { ok: false, status: 402, error: "budget exceeded" };
    }
    const now = new Date().toISOString();
    const run: Run = {
      id: crypto.randomUUID(),
      status: "queued",
      task,
      agent,
      repo,
      principal,
      // always resolved (never left blank): the record shows where the run executed
      dispatch: (dispatchMode as DispatchMode) ?? dispatcher.defaultMode,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.create(run);
    dispatcher.dispatch(run); // substrate seam (ADR-0031): routes by run.dispatch
    return { ok: true, run };
  };
}
