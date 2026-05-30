/**
 * agent-runtime — the L1 runtime as an HTTP service (the "front door"), async +
 * gated.
 *
 * A run is a first-class, persisted entity (the State primitive — core/runs),
 * scoped by the `gate` control (identity + budget — ADR-0009):
 *   POST /runs  {"task":"..."}  -> 202 { runId, status:"queued", tenant }
 *     Authorization: Bearer <token>  (under GATE=local; open under the default)
 *   GET  /runs/{id}                 -> the Run { status, messages, output?, usage, costUsd }
 *   GET  /tenants/{tenant}/budget   -> { limitUsd, spentUsd, remainingUsd, ok }
 *   GET  /healthz                   -> { status: "ok" }
 *
 * An in-process worker executes runs, persisting state each turn; spend is costed
 * from token usage and recorded against the tenant after each run.
 *
 *   GATE=local GATE_TOKENS="tok:teamA:alice" GATE_BUDGET_USD=1.00 bun run start
 */
import {
  runOnSession,
  providersFromEnv,
  estimateCostUsd,
  AdmissionInferenceProvider,
  UnauthorizedError,
  type Run,
} from "@agent-os/core";

const providers = providersFromEnv(); // once per process (OTel registers globally)
const { gate, authenticator, authorizer, toolProvider, runStore: store, agentRegistry } = providers;
const port = Number(process.env.PORT ?? 3000);
// per-turn output cap (ADR-0013); undefined -> the loop's built-in default
const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;

const bearer = (req: Request): string | undefined =>
  req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
// lowercased header map for the Authenticator (mesh/IAP edge forwards claims here)
const headerMap = (req: Request): Record<string, string> => Object.fromEntries(req.headers);

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

/** The worker: execute a queued run, persisting state + accounting spend. */
async function processRun(id: string): Promise<void> {
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
  // resolve a tenant-scoped inference provider — assumes the tenant's IAM role so
  // the model call acts AS the tenant (ADR-0014); falls back to the shared provider
  // when per-tenant identity is off. Then wrap in the per-tenant admission decorator:
  // worst-case cost is priced + checked against the budget before each call, and
  // actual spend recorded per turn (the cost hard-stop, ADR-0013).
  const baseInference = await providers.inferenceForTenant(tenant);
  const inference = new AdmissionInferenceProvider(baseInference, gate, tenant);
  try {
    const result = await runOnSession({
      inference,
      guard: providers.guard,
      telemetry: providers.telemetry,
      session,
      task: existing.task,
      systemPrompt: spec?.systemPrompt,
      maxSteps: spec?.maxSteps,
      maxOutputTokens,
      tools: () => toolset.tools,
      onProgress: (messages) => {
        store.update(id, { messages }).catch(() => {}); // durable per-turn state
      },
    });
    // spend is recorded per-turn by the admission decorator; here we just persist
    // the run's total cost for the dashboard / run record.
    const costUsd = estimateCostUsd(providers.inference.model, result.usage);
    await store.update(id, { status: result.status, output: result.output, usage: result.usage, costUsd });
  } catch (e: any) {
    await store.update(id, { status: "failed", error: e?.message ?? String(e) });
  } finally {
    await toolset.close().catch(() => {});
    await session.close().catch(() => {});
  }
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

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
      });
    }

    if (req.method === "GET" && url.pathname === "/runs") {
      const runs = await store.list(100);
      return Response.json(runs.map(({ messages, ...slim }) => slim)); // list omits the conversation
    }

    if (req.method === "POST" && url.pathname === "/runs") {
      // gate (ADR-0015): authn → authz(of the target agent) → budget
      let principal;
      try {
        principal = await authenticator.authenticate({ credential: bearer(req), headers: headerMap(req) });
      } catch (e) {
        if (e instanceof UnauthorizedError) return Response.json({ error: "unauthorized" }, { status: 401 });
        throw e;
      }

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
      const agent = body?.agent;

      // authz: may this principal create a run of this agent? (policy sees the agent
      // as the resource — e.g. OPA can gate sensitive agents on group membership)
      const decision = await authorizer.authorize(principal, "run:create", agent != null ? String(agent) : undefined);
      if (!decision.allow) return Response.json({ error: "forbidden", reason: decision.reason }, { status: 403 });
      const budget = await gate.checkBudget(principal.tenant);
      if (!budget.ok) return Response.json({ error: "budget exceeded", budget }, { status: 402 });

      // agent control plane (#5): if an agent is named, it must be registered
      if (agent != null && !(await agentRegistry.get(String(agent)))) {
        return Response.json({ error: `unknown agent '${agent}'` }, { status: 404 });
      }
      const now = new Date().toISOString();
      const run: Run = { id: crypto.randomUUID(), status: "queued", task, agent, principal, messages: [], createdAt: now, updatedAt: now };
      await store.create(run);
      void processRun(run.id); // fire-and-forget worker (in-process for now)
      return Response.json({ runId: run.id, status: run.status, agent, tenant: principal.tenant }, { status: 202 });
    }

    if (req.method === "GET" && url.pathname === "/agents") {
      return Response.json(await agentRegistry.list());
    }

    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = await store.get(runMatch[1]!);
      return run ? Response.json(run) : Response.json({ error: "run not found" }, { status: 404 });
    }

    const budgetMatch = url.pathname.match(/^\/tenants\/([^/]+)\/budget$/);
    if (req.method === "GET" && budgetMatch) {
      return Response.json(await gate.checkBudget(budgetMatch[1]!));
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(
  `agent-runtime listening on :${server.port}  (async; store=${store.name}; gate=${gate.name}; ` +
    `authn=${authenticator.name} authz=${authorizer.name}; ` +
    `inference=${providers.inference.name} sandbox=${providers.sandbox.name} ` +
    `guard=${providers.guard.name} record=${providers.telemetry.name})`,
);
