# agent-os — diagrams only

> Diagram-per-idea, no speaker notes. For the narrated version see [`walkthrough.md`](walkthrough.md);
> for the prose reference see [`platform.md`](platform.md); for the cost model see [`costs.md`](costs.md).

---

## 1 · The premise

```mermaid
flowchart LR
  G["Two north stars:<br/><b>it scales</b> · <b>it's secure</b>"]
```

---

## 2 · Why agents are hard

```mermaid
flowchart TB
  M["The model decides what to do<br/><i>at runtime</i>"] --> P1["so isolation can't<br/>trust the model"]
  M --> P2["it writes + runs its<br/>own code → untrusted"]
  M --> P3["a loop can burn budget<br/>in seconds"]
  M --> P4["it acts for a human<br/>AND as itself"]
```

---

## 3 · The whole thing in three layers

```mermaid
flowchart TB
  L2["<b>L2 · POLICY</b><br/>what each agent / tenant is ALLOWED to do"]
  L1["<b>L1 · COMPOSITION</b><br/>the loop that runs one task"]
  L0["<b>L0 · MECHANISM</b><br/>the parts: think · do · remember + gate · record · guard"]
  L2 -->|constrains| L1
  L1 -->|uses| L0
```

---

## 4 · First, watch one task run — the loop (this is "the agent")

```mermaid
flowchart TD
  Start(["task comes in"]) --> Guard1["guard: screen input"]
  Guard1 --> Think["<b>think</b>: model generates"]
  Think --> Q{"wants a tool?"}
  Q -- "no" --> Done(["return the answer"])
  Q -- "yes" --> Do["<b>do</b>: run it in the sandbox"]
  Do --> Guard2["guard: screen the result"]
  Guard2 --> Rem["<b>remember</b>: persist progress"]
  Rem --> Think
```

*The bold steps — **think · do · remember** — are the **primitives** (the agent's work); the **guard** wrapping them is a **control** (the platform's check). We name the parts next.*

---

## 5 · L0 — the parts

```mermaid
flowchart LR
  subgraph PRIM["PRIMITIVES — the agent's work (data plane)"]
    direction LR
    T["think"] ~~~ D["do (run / call)"] ~~~ R["remember"]
  end
  subgraph CTRL["CONTROLS — the platform's checks (control plane)"]
    direction LR
    G["gate"] ~~~ Rec["record"] ~~~ Gu["guard"]
  end
```

*Test — **delete it**: can't make progress = a **primitive** (the agent's work) · runs but ungoverned = a **control** (the platform's checks). Same split as k8s: pods vs RBAC + quota + admission.*

*Controls wrap primitives — the **gate** admits + meters each `think` (the 402); **guard** screens what crosses into it; **record** traces every step.*

---

## 6 · The three primitives

```mermaid
flowchart TB
  T["<b>think</b> · ask a model → text + tool calls<br/>InferenceProvider"]
  D["<b>do</b> · run code or call a tool — isolated<br/>SandboxProvider + ToolProvider"]
  R["<b>remember</b> · persist state across turns + runs<br/>RunStore → StateStore"]
```

---

## 7 · The three controls

```mermaid
flowchart LR
  Step["every step the agent takes"]
  Step --> G["<b>gate</b><br/>may this actor<br/>do this, afford this?"]
  Step --> Rec["<b>record</b><br/>trace it<br/>(replayable)"]
  Step --> Gu["<b>guard</b><br/>is this content<br/>safe / not poisoned?"]
```

---

## 8 · Everything is swappable

```mermaid
flowchart LR
  Port["one PORT<br/>(e.g. think)"]
  Port --> A1["Bedrock"]
  Port --> A2["Ollama (laptop)"]
  Port --> A3["the gateway"]
  Port -. "chosen by<br/>one env var" .-> Port
```

---

## 9 · The gate, opened up

```mermaid
sequenceDiagram
  participant Pod as pod · SA token
  participant GW as inference-gateway
  participant K8s as k8s API
  participant Bud as budget store
  participant Model
  loop every think
    Pod->>GW: generate + SA token
    GW->>K8s: 1 authn — TokenReview
    K8s-->>GW: verified identity + tenant
    GW->>GW: 2 authz — may this tenant / model?
    GW->>Bud: 3 budget — reserve worst-case $, atomic
    Bud-->>GW: ok — else 402
    GW->>Model: call with gateway's OWN credential
    Model-->>GW: tokens
    GW->>Bud: settle actual $
    GW-->>Pod: result
  end
  Note over Pod,Model: 4 creds — only on a `do` to an external tool:<br/>broker mints a scoped secret, server-side — per do, not per think
```

---

## 10 · A run, end to end

```mermaid
sequenceDiagram
  actor Caller
  participant RT as agent-runtime
  participant Gate
  participant GW as inference-gateway
  participant LP as agent loop
  participant Sand as sandbox
  Caller->>RT: POST /runs with task + identity
  RT->>Gate: authn, then authz, then reserve budget
  Gate-->>RT: ok, else 401/403/402
  RT-->>Caller: 202 runId, poll later
  Note over LP,Sand: each turn, until done
  LP->>GW: think
  GW->>Gate: budget reserve and settle
  LP->>Sand: do - run a tool
  LP->>LP: guard + record + remember
  LP->>RT: store final status + output + cost
  Caller->>RT: GET /runs/runId
  RT-->>Caller: status + output + cost
```

---

## 11 · L1 vs L2 — one engine, many agents

```mermaid
flowchart LR
  subgraph DEF["① L2 · define once (config + policy)"]
    A["AgentSpec — prompt · tools · model · budget<br/>+ claim: what it's allowed"]
  end
  subgraph RUN["② call per task"]
    T["POST /runs {agent, task}  (service)<br/>· or runAgent(cfg, task)  (lib)"]
  end
  subgraph ONE["L1 · one loop — runOnSession"]
    M["lib: import @agent-os/core (you host)<br/>service: agent-runtime (we host + govern)"]
  end
  A -->|"configures"| ONE
  T -->|"invokes by name"| ONE
```

*L1 = one loop, shipped as a lib or a service. L2 = define the agent once (config + policy), then call it per task — define once, call many; the same loop serves every agent.*

---

## 12 · L2 — policy sets the values; the platform enforces the limits

```mermaid
flowchart TB
  INV["<b>Platform invariants — L0/L1, always on, not optional</b><br/>every call gated · every run budgeted · sessions capped · only reachable models"]
  ADMIN["<b>Admin allowance</b><br/>the ceiling: max $, the model menu"] --> CLAIM["<b>Tenant claim</b> — self-service, within the ceiling<br/>'model X, $Y budget' — just data, not a terraform ticket"]
  CLAIM -->|"decided at L2"| ENF["enforced at L0/L1 every run<br/>→ admit · 402 · 403"]
  INV --> ENF
```

---

## 13 · Sandbox — and coding agents

```mermaid
flowchart TB
  subgraph A["Model A — sandbox as tool-executor"]
    LA["our loop"] -->|"each tool call"| SA["sandbox<br/>(AgentCore CI)"]
  end
  subgraph B["Model B — a coding agent in a box"]
    SB["sandbox runs Claude Code /<br/>Copilot CLI (E2B / self-host k8s)"]
    SB -->|"think — allowed"| GW2["gateway"]
    SB -->|"any other egress"| LOCK["🚫 locked down"]
  end
```

---

## 14 · Memory — the right store per tier

```mermaid
flowchart LR
  Loop["the loop"] --> PG[("<b>Postgres</b> — system of record<br/>runs · budget · memory · pgvector")]
  Loop --> RD[("<b>Redis</b> — hot tier<br/>cache · queue · locks")]
  PG -. "retrieved memory<br/>re-enters context" .-> Gu["guard screens it<br/>(poison = persistent injection)"]
```

---

## 15 · Managed vs self-hosted — the cost curve

```mermaid
flowchart LR
  POC["POC / low volume<br/>mostly idle"] -->|"managed wins<br/>~$0 idle · no upfront · zero ops"| M["managed adapter"]
  SCALE["100s of agents<br/>high utilization"] -->|"self-host wins<br/>2–3× cheaper on spot/reserved"| S["self-hosted sandbox<br/>(Kata/gVisor on EKS)"]
  M -. "same agent code —<br/>swap one port" .-> S
```

*Unit rates & worked example → [`costs.md`](costs.md). Managed ≈ 2× on-demand, 5–7× spot; break-even ~15% utilization on spot. The curve is now a deployment choice: two profiles, one contract ([ADR-0027](decisions/0027-two-deployment-profiles.md)) — full-mode store live as Aurora Serverless v2, pausing to $0 after 5 idle min.*

---

## 16 · Where it stands

```mermaid
flowchart LR
  subgraph RUNS["proven · live"]
    R1["verified identity<br/>+ forgery defense"] ~~~ R2["budget 402 +<br/>reserve→settle vs Bedrock"] ~~~ R3["our Bun/TS gateway<br/>bespoke + Anthropic wire"] ~~~ R4["A2A on-behalf-of<br/>(EKS)"] ~~~ R5["store: Dynamo +<br/>Aurora scale-to-zero"]
  end
  subgraph NEXT["next"]
    N1["egress lockdown<br/>(the sandbox pillar)"] ~~~ N2["cross-run memory"] ~~~ N3["conformance suite ·<br/>mesh-trust · scale-out"]
  end
```
