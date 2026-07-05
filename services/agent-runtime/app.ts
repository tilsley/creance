/**
 * createApp — the runtime's HTTP surface as a single `(Request) => Response`
 * handler, independent of what SERVES it (ADR-0031). This is the front-door
 * analogue of process-run.ts: one body, two substrates.
 *   - server.ts  serves it with Bun.serve      (always-on, full-k8s).
 *   - lambda.ts  serves it via the Lambda Runtime API loop (serverless front
 *     door — no HTTP server, no Lambda Web Adapter).
 * Routes, gate, and dispatch are identical across both; only the thing calling
 * this handler differs. The gate sequence (authn → authz → budget → create →
 * dispatch) lives in router.ts; the dispatch strategy is picked by env in
 * dispatch.ts (DISPATCH=inprocess|runtask).
 */
import { type Providers } from "@agent-os/core";
import { handleA2A, buildAgentCard } from "./a2a";
import { makeAuthorizeAndCreate } from "./router";
import { dispatchFromEnv } from "./dispatch";

export interface AppOpts {
  /** per-turn output cap (ADR-0013); undefined → the loop's built-in default. */
  maxOutputTokens?: number;
  /** the agent this runtime advertises over A2A (and runs when none is named). */
  a2aAgent?: string;
}


/**
 * Build the runtime's request handler over a set of providers. Wires the dispatch
 * strategy (DISPATCH env) and the gate once, then returns the router. Call
 * providersFromEnv() ONCE per process and pass the result in (OTel registers a
 * global provider); this function does no such global registration, so it's safe
 * to call from either entrypoint.
 */
export function createApp(providers: Providers, opts: AppOpts = {}): (req: Request) => Promise<Response> {
  const { gate, authenticator, authorizer, runStore: store, agentRegistry } = providers;
  const a2aAgent = opts.a2aAgent;

  // The gate sequence (authn → authz → budget → create → dispatch), with the
  // dispatch strategy picked by env (ADR-0031): DISPATCH=inprocess runs the worker
  // in this process (full-k8s); DISPATCH=runtask makes this the serverless front
  // door, launching a Fargate task-per-run.
  const dispatch = dispatchFromEnv(providers, { maxOutputTokens: opts.maxOutputTokens });
  const authorizeAndCreate = makeAuthorizeAndCreate(providers, dispatch);

  const bearer = (req: Request): string | undefined =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  // lowercased header map for the Authenticator (mesh/IAP edge forwards claims here)
  const headerMap = (req: Request): Record<string, string> => Object.fromEntries(req.headers);

  // READS are authenticated too (ADR-0032): run transcripts and budgets are tenant
  // data, and the console proved the gap — an open GET /runs/{id} would hand out
  // whatever the store holds. Same Authenticator as the create path; under noop
  // authn (dev default) this stays open, so local flows are unchanged.
  const authenticated = async (req: Request): Promise<boolean> => {
    try {
      await authenticator.authenticate({ credential: bearer(req), headers: headerMap(req) });
      return true;
    } catch {
      return false;
    }
  };
  const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
  // Never return the caller's raw bearer token (it's a live credential the run
  // carries for OBO exchange, ADR-0010) — strip it from every read response.
  const redact = <T extends { principal?: { token?: string } }>(run: T): T =>
    run.principal ? { ...run, principal: { ...run.principal, token: undefined } } : run;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // --- A2A protocol surface (ADR-0018): discovery + JSON-RPC ---
    if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
      return Response.json(
        buildAgentCard({
          name: a2aAgent ?? "agent-os-runtime",
          description: `agent-os runtime hosting '${a2aAgent ?? "agents"}'`,
          url: `${url.protocol}//${url.host}/a2a`,
        }),
      );
    }
    if (req.method === "POST" && url.pathname === "/a2a") {
      return handleA2A(req, { createRun: authorizeAndCreate, getRun: (id) => store.get(id), defaultAgent: a2aAgent });
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    // The inline dashboard that used to live here is retired (ADR-0032): the web
    // console (apps/console) is the UI, and it couldn't work anyway now that the
    // read routes require a verified identity.
    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({ service: "agent-os-runtime", ui: "apps/console (ADR-0032)", health: "/healthz" });
    }

    if (req.method === "GET" && url.pathname === "/info") {
      return Response.json({
        inference: providers.inference.name,
        model: providers.inference.model,
        sandbox: providers.sandbox.name,
        store: store.name,
        gate: gate.name,
        authn: authenticator.name,
        authz: authorizer.name,
        guard: providers.guard.name,
        agentRegistry: agentRegistry.name,
        memory: providers.memory?.name ?? "off",
      });
    }

    if (req.method === "GET" && url.pathname === "/runs") {
      if (!(await authenticated(req))) return unauthorized();
      const runs = await store.list(100);
      return Response.json(runs.map(({ messages, ...slim }) => redact(slim))); // list omits the conversation
    }

    if (req.method === "POST" && url.pathname === "/runs") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const task = body?.task;
      if (typeof task !== "string" || !task.trim()) {
        return Response.json({ error: "missing 'task' (string)" }, { status: 400 });
      }
      const agent = body?.agent != null ? String(body.agent) : undefined;
      // target repo for coding runs (ADR-0034): "owner/name" only — a resource the
      // gate authorizes, then the egress sidecar pins its allowlist to.
      const repo = body?.repo != null ? String(body.repo) : undefined;
      if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        return Response.json({ error: "invalid 'repo' (expected owner/name)" }, { status: 400 });
      }
      // same gate as A2A: authn → authz(agent, repo) → budget → create (ADR-0015/0018)
      const r = await authorizeAndCreate(bearer(req), headerMap(req), agent, task, repo);
      if (!r.ok) return Response.json({ error: r.error, reason: r.reason }, { status: r.status });
      return Response.json({ runId: r.run.id, status: r.run.status, agent, repo, tenant: r.run.principal!.tenant }, { status: 202 });
    }

    if (req.method === "GET" && url.pathname === "/agents") {
      if (!(await authenticated(req))) return unauthorized();
      return Response.json(await agentRegistry.list());
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      if (!(await authenticated(req))) return unauthorized();
      const run = await store.get(runMatch[1]!);
      return run ? Response.json(redact(run)) : Response.json({ error: "run not found" }, { status: 404 });
    }

    const budgetMatch = url.pathname.match(/^\/tenants\/([^/]+)\/budget$/);
    if (req.method === "GET" && budgetMatch) {
      if (!(await authenticated(req))) return unauthorized();
      return Response.json(await gate.checkBudget(budgetMatch[1]!));
    }

    return new Response("not found", { status: 404 });
  };
}
