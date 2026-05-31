// Runs INSIDE the caller pod (bun). Drives the ADR-0019 e2e against the in-cluster
// runtime + gateway, authenticating with the pod's own projected ServiceAccount token.
const RT = "http://e2e-runtime.agentos-e2e.svc.cluster.local";
const GW = "http://e2e-gateway.agentos-e2e.svc.cluster.local";
const token = (await Bun.file("/var/run/secrets/agentos/token").text()).trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function run(agent, task, auth = token) {
  const res = await fetch(`${RT}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ agent, task }),
  });
  if (res.status !== 202) return { httpStatus: res.status, body: await res.json().catch(() => ({})) };
  const { runId } = await res.json();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await (await fetch(`${RT}/runs/${runId}`)).json();
    if (["completed", "failed", "stuck", "blocked", "max_steps"].includes(r.status)) return { httpStatus: 202, run: r };
  }
  return { httpStatus: 202, run: { status: "timeout" } };
}

console.log("\n=== ADR-0019 local-k3s e2e ===\n");

// 1 — slice 1+2: verified SA identity (TokenReview) → tenant from claim → gateway inference
const a = await run("demo-bot", "say the answer");
check("slice 1+2  verified-identity run reaches the gateway and completes",
  a.run?.status === "completed" && a.run?.output === "answer-from-gateway", `${a.run?.status}: ${a.run?.output ?? a.run?.error ?? ""}`);

// 2 — slice 4: a sandboxed (Model B) agent runs IN the sandbox, reaches the model via the gateway
const b = await run("sandbox-bot", "say the answer");
check("slice 4    sandboxed agent (Model B) reaches the model only via the gateway",
  b.run?.status === "completed" && b.run?.output === "answer-from-gateway", `${b.run?.status}: ${b.run?.output ?? b.run?.error ?? ""}`);

// 3 — slice 3: budget hard-stop — a big direct call trips the per-session cap at the gateway
const big = await fetch(`${GW}/v1/generate`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ messages: [{ role: "user", text: "x" }], tools: [], maxTokens: 100000, sessionId: "runaway-1" }),
});
check("slice 3    over-session-cap request is refused at the gateway (402)", big.status === 402, `HTTP ${big.status}`);

// 4 — slice 1 negative: no token → unauthenticated → 401 (forgeable header can't get in)
const noauth = await fetch(`${RT}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "demo-bot", task: "x" }) });
check("slice 1    unauthenticated caller is rejected (401)", noauth.status === 401, `HTTP ${noauth.status}`);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
