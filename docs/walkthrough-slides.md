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

## 3 · The real question: buy, build, or both?

```mermaid
flowchart TB
  Q["Run agents at scale & securely — buy or build?"]
  Q --> B1["<b>BUY</b> · all-in managed<br/>AgentCore · Claude MA · Vertex<br/>~$0 idle, fast — but lock-in &<br/>no real-time budget cap"]
  Q --> B2["<b>BUILD</b> · self-host everything<br/>control + cheapest at scale —<br/>but upfront build + idle cost"]
  Q --> B3["<b>BOTH</b> · pick per capability,<br/>ride the cost curve<br/>← what this platform enables"]
```

---

## 4 · The whole thing in three layers

```mermaid
flowchart TB
  L2["<b>L2 · POLICY</b><br/>what each agent / tenant is ALLOWED to do"]
  L1["<b>L1 · COMPOSITION</b><br/>the loop that runs one task"]
  L0["<b>L0 · MECHANISM</b><br/>the parts: think · do · remember + gate · record · guard"]
  L2 -->|constrains| L1
  L1 -->|uses| L0
```

---

## 5 · L0 — the parts

```mermaid
flowchart LR
  subgraph PRIM["PRIMITIVES — the agent CALLS these"]
    direction LR
    T["think"] ~~~ D["do"] ~~~ R["remember"]
  end
  subgraph CTRL["CONTROLS — the platform ENFORCES these"]
    direction LR
    G["gate"] ~~~ Rec["record"] ~~~ Gu["guard"]
  end
```

*Controls wrap primitives — e.g. the **gate** admits + meters each `think` (the 402); **guard** screens what crosses into it; **record** traces every step.*

---

## 6 · The three primitives

```mermaid
flowchart TB
  T["<b>think</b> · InferenceProvider<br/>ask a model → text + tool calls"]
  D["<b>do</b> · SandboxProvider + ToolProvider<br/>run code / call a tool, isolated"]
  R["<b>remember</b> · RunStore → StateStore<br/>persist state across turns + runs"]
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

## 9 · L1 — the loop (this is "the agent")

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

---

## 10 · The gate, opened up

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

## 11 · A run, end to end

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

## 12 · L1 vs L2 — one engine, many agents

```mermaid
flowchart TB
  Loop["<b>L1</b>: one loop · runOnSession<br/><i>generic engine</i>"]
  Loop --> A1["dep-migrator<br/>prompt + tools + $5"]
  Loop --> A2["ticket-bot<br/>prompt + tools + $2"]
  Loop --> A3["… your agent<br/>prompt + tools + $"]
```

---

## 13 · L2 — policy sets the values; the platform enforces the limits

```mermaid
flowchart TB
  INV["<b>Platform invariants — L0/L1, always on, not optional</b><br/>every call gated · every run budgeted · sessions capped · only reachable models"]
  ADMIN["<b>Admin allowance</b><br/>the ceiling: max $, the model menu"] --> CLAIM["<b>Tenant claim</b> — self-service, within the ceiling<br/>'model X, $Y budget' — just data, not a terraform ticket"]
  CLAIM -->|"decided at L2"| ENF["enforced at L0/L1 every run<br/>→ admit · 402 · 403"]
  INV --> ENF
```

---

## 14 · Sandbox — and coding agents

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

## 15 · Memory — the right store per tier

```mermaid
flowchart LR
  Loop["the loop"] --> PG[("<b>Postgres</b> — system of record<br/>runs · budget · memory · pgvector")]
  Loop --> RD[("<b>Redis</b> — hot tier<br/>cache · queue · locks")]
  PG -. "retrieved memory<br/>re-enters context" .-> Gu["guard screens it<br/>(poison = persistent injection)"]
```

---

## 16 · Managed vs self-hosted — the cost curve

```mermaid
flowchart LR
  POC["POC / low volume<br/>mostly idle"] -->|"managed wins<br/>~$0 idle · no upfront · zero ops"| M["managed adapter"]
  SCALE["100s of agents<br/>high utilization"] -->|"self-host wins<br/>2–3× cheaper on spot/reserved"| S["self-hosted sandbox<br/>(Kata/gVisor on EKS)"]
  M -. "same agent code —<br/>swap one port" .-> S
```

*Unit rates & worked example → [`costs.md`](costs.md). Managed ≈ 2× on-demand, 5–7× spot; break-even ~15% utilization on spot.*

---

## 17 · Where it stands

```mermaid
flowchart LR
  subgraph RUNS["proven (EKS + local k3s)"]
    R1["verified identity"] ~~~ R2["budget 402"] ~~~ R3["A2A on-behalf-of"]
  end
  subgraph NEXT["next"]
    N1["egress lockdown"] ~~~ N2["cross-run memory"] ~~~ N3["scale-out"]
  end
```
