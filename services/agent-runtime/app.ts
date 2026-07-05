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

// A self-contained runs dashboard (served at GET /): a live view of agent runs —
// status, agent, tokens, cost, and the full conversation — plus a launch form.
const DASHBOARD_HTML = `<!doctype html><html><head><meta charset=utf-8><title>agent-os</title><style>
 body{font:13px/1.5 ui-monospace,Menlo,monospace;margin:0;background:#0d1117;color:#c9d1d9}
 header{padding:12px 16px;border-bottom:1px solid #21262d;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
 h1{font-size:15px;margin:0;color:#58a6ff} .muted{color:#8b949e}
 main{display:grid;grid-template-columns:1fr 1fr;height:calc(100vh - 52px)}
 section{overflow:auto;padding:12px 16px} #detail{border-left:1px solid #21262d}
 table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d;font-size:12px}
 th{color:#8b949e;font-weight:400;position:sticky;top:0;background:#0d1117}
 tr.run{cursor:pointer} tr.run:hover{background:#161b22}
 .st{padding:1px 7px;border-radius:10px;font-size:11px}
 .completed{background:#15331e;color:#4ade80}.failed,.blocked,.stuck,.max_steps{background:#3a1a1a;color:#f87171}
 .running{background:#3a2f12;color:#fbbf24}.queued{background:#21262d;color:#8b949e}
 form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
 input,textarea,select,button{font:inherit;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;padding:5px 8px}
 button{background:#238636;border-color:#2ea043;color:#fff;cursor:pointer}
 pre{white-space:pre-wrap;word-break:break-word;background:#161b22;padding:10px;border-radius:6px;border:1px solid #21262d}
 .msg{margin:6px 0;padding:6px 10px;border-radius:6px;border:1px solid #21262d}
 .user{border-left:3px solid #58a6ff}.assistant{border-left:3px solid #4ade80}.tool{border-left:3px solid #fbbf24}
</style></head><body>
<header><h1>agent-os</h1><span id=info class=muted>…</span></header>
<main>
 <section>
  <form id=launch>
   <input id=token placeholder="Bearer token" size=12>
   <select id=agent><option value="">(no agent)</option></select>
   <input id=task placeholder="task…" style="flex:1;min-width:180px">
   <button>Run</button>
  </form>
  <table><thead><tr><th>status</th><th>agent</th><th>task</th><th>tok</th><th>$</th><th>when</th></tr></thead><tbody id=rows></tbody></table>
 </section>
 <section id=detail class=muted>select a run…</section>
</main>
<script>
const $=s=>document.querySelector(s), esc=s=>(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const rel=t=>{const s=(Date.now()-new Date(t))/1000;return s<60?Math.round(s)+'s':s<3600?Math.round(s/60)+'m':Math.round(s/3600)+'h';};
async function loadInfo(){try{const i=await (await fetch('/info')).json();
 $('#info').textContent='inference='+i.inference+' · sandbox='+i.sandbox+' · store='+i.store+' · gate='+i.gate+' · guard='+i.guard+' · agents='+i.agentRegistry;
 const ag=await (await fetch('/agents')).json();
 $('#agent').innerHTML='<option value="">(no agent)</option>'+ag.map(a=>'<option>'+esc(a.name)+'</option>').join('');}catch(e){}}
async function loadRuns(){try{const runs=await (await fetch('/runs')).json();
 $('#rows').innerHTML=runs.map(r=>'<tr class=run data-id="'+r.id+'"><td><span class="st '+r.status+'">'+r.status+'</span></td><td>'+esc(r.agent||'')+'</td><td>'+esc((r.task||'').slice(0,42))+'</td><td>'+((r.usage&&(r.usage.inputTokens||0)+(r.usage.outputTokens||0))||'')+'</td><td>'+(r.costUsd?'$'+r.costUsd.toFixed(5):'')+'</td><td class=muted>'+rel(r.createdAt)+'</td></tr>').join('');
 document.querySelectorAll('tr.run').forEach(tr=>tr.onclick=()=>showRun(tr.dataset.id));}catch(e){}}
async function showRun(id){const r=await (await fetch('/runs/'+id)).json(); const d=$('#detail'); d.classList.remove('muted');
 d.innerHTML='<div><span class="st '+r.status+'">'+r.status+'</span> <b>'+esc(r.agent||'(default)')+'</b> <span class=muted>'+esc(r.id)+'</span></div><p class=muted>'+esc(r.task||'')+'</p>'
  +(r.error?'<pre style="color:#f87171">'+esc(r.error)+'</pre>':'')
  +(r.output?'<b>output</b><pre>'+esc(r.output)+'</pre>':'')
  +'<b>conversation ('+((r.messages||[]).length)+')</b>'
  +(r.messages||[]).map(m=>'<div class="msg '+m.role+'"><span class=muted>'+m.role+'</span> '+esc(m.text||'')
    +(m.toolCalls||[]).map(t=>'<div class=muted>🛠 '+esc(t.name)+' '+esc(JSON.stringify(t.input))+'</div>').join('')
    +(m.results||[]).map(t=>'<div class=muted>📤 '+esc((t.output||'').slice(0,400))+'</div>').join('')+'</div>').join('');}
$('#launch').onsubmit=async e=>{e.preventDefault(); const body={task:$('#task').value}; if($('#agent').value)body.agent=$('#agent').value;
 const h={'content-type':'application/json'}; if($('#token').value)h.authorization='Bearer '+$('#token').value;
 const res=await fetch('/runs',{method:'POST',headers:h,body:JSON.stringify(body)});
 if(res.ok){$('#task').value='';setTimeout(loadRuns,400);}else alert('POST '+res.status+': '+await res.text());};
loadInfo();loadRuns();setInterval(loadRuns,3000);
</script></body></html>`;

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

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
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
      // same gate as A2A: authn → authz(agent) → budget → create (ADR-0015/0018)
      const r = await authorizeAndCreate(bearer(req), headerMap(req), agent, task);
      if (!r.ok) return Response.json({ error: r.error, reason: r.reason }, { status: r.status });
      return Response.json({ runId: r.run.id, status: r.run.status, agent, tenant: r.run.principal!.tenant }, { status: 202 });
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
