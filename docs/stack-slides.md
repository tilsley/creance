# agent-os — the stack (ideas)

> Diagram-per-idea, no speaker notes. This deck is **ideas, not a demo** — what an
> agentic platform actually needs. I built each piece to *understand* it; the building
> was the way in, not the point. For the prose reference see [`platform.md`](platform.md)
> and [`primitives.md`](primitives.md).

---

## 1 · The harnesses we use every day

```mermaid
flowchart TB
  subgraph TOOLS["the tools we use — all harnesses"]
    direction LR
    TUI["TUI<br/>OpenCode · Claude Code"] ~~~ WEB["web UI<br/>Gemini · ChatGPT"]
  end
  TOOLS ==> V["the vocabulary they taught you:<br/>skills · workflows · evals · reasoning · MCP · context"]
  V ==> H["…and each one quietly handles the rest for you:<br/>the model call · the tools · your history · the bill"]
```

*These are the tools we use every day — and each one quietly handles a lot underneath. This deck names what they handle, so the words mean the same thing for all of us.*

---

## 2 · Agent vs harness

```mermaid
flowchart TB
  subgraph HARNESS["HARNESS — the software you run · OpenCode (TUI) · Gemini (web UI)<br/>UI · tool dispatch · context · persistence"]
    Start(["task"]) --> Think["<b>think</b> — call a model"]
    Think --> Q{"act?"}
    Q -- "no" --> Done(["answer"])
    Q -- "yes" --> Do["<b>do</b> — run code / call a tool"]
    Do --> Rem["<b>remember</b> — save state"]
    Rem --> Think
  end
```

```mermaid
flowchart LR
  H["<b>harness</b> · the engine<br/><i>runtime</i>"] -->|"loads an"| A["<b>agent</b> · prompt · tools · model · budget<br/><i>program / config</i>"] -->|"instantiated per task as a"| Run["<b>run</b> · one live execution<br/><i>process / instance</i>"]
```

*The harness runs the loop above. An **agent** is a *configuration* of that loop — a purpose: prompt + tools + model + budget. A **run** is one execution of it. So: **engine → program → process** — one harness runs many agents; each agent spawns many runs. (A harness can also run *non*-agentic flows — one question, one answer, no loop.)*

---

## 3 · The picture — it's a stack

```mermaid
flowchart TB
  subgraph CRAFT["THE CRAFT — making the agent good"]
    direction LR
    R["reasoning"] ~~~ Sk["skills"] ~~~ Wf["workflows"] ~~~ Ev["evals"]
  end
  subgraph HARNESS["THE HARNESS — the software that runs the agent loop"]
    L["think → do → remember, every step"]
  end
  subgraph PLATFORM["THE PLATFORM — the part your tools handle for you"]
    direction LR
    P["inference · sandbox · state"] ~~~ Ct["gate · record · guard"]
  end
  CRAFT -->|"rests on"| HARNESS
  HARNESS -->|"rests on"| PLATFORM
```

*The craft sits on a harness; the harness sits on a platform. Strip the vocabulary and most of the craft is just a way to arrange `think`, `do`, `remember`. Take a layer away and everything above it falls.*

---

## 4 · The platform — two kinds of foundation

```mermaid
flowchart LR
  subgraph PRIM["PRIMITIVES — the agent's work"]
    direction LR
    T["think"] ~~~ D["do"] ~~~ Rm["remember"]
  end
  subgraph CTRL["CONTROLS — the platform's checks"]
    direction LR
    G["gate"] ~~~ Rc["record"] ~~~ Gu["guard"]
  end
```

*A **primitive** is an irreducible capability the agent acts with to make progress — one you can't build from the others. Test — **delete it**: can't make progress = a **primitive** · runs but ungoverned = a **control**. Same split as k8s: pods vs RBAC + quota + admission.*

---

## 5 · Free at n=1, fatal at n>1

```mermaid
flowchart LR
  Lap["on your laptop (n=1)<br/>your money · your machine ·<br/>you trust yourself<br/>→ the platform is invisible"]
  Lap ==>|"the moment it's not just you"| Real["<b>four things break:</b><br/>many users → <b>identity</b> · gate<br/>real money → <b>budget hard-stop</b> · gate<br/>real blast radius → <b>isolation + egress</b> · sandbox<br/>shared memory → <b>poisoning</b> · guard"]
```

*The platform is everything your laptop hands you for free at n=1 and that becomes fatal at scale — so the tools never make you think about it. Each of the four is a load-bearing part I only believed once I'd built it and watched it matter.*

---

## 6 · That's the idea — now here's how we build it

```mermaid
flowchart LR
  Idea["<b>the idea</b> · vendor-neutral<br/>craft needs a harness ·<br/>harness needs a platform<br/>→ the platform is the precondition<br/>for production, not a demo"] ==>|"so: build the platform,<br/>start the craft now on stubs"| Build["<b>our build</b> · next slides<br/>agent-runtime · inference-gateway ·<br/>sandbox-manager · store<br/>— each primitive + control behind a port"]
```

*Everything up to here is true of **any** agentic platform. From here it's **our** implementation of it — the same six parts, named as components. The craft is necessary but not sufficient; the platform is what makes it survive production; the seam (ports) is what lets us build it without blocking the craft.*

---

## 7 · Architecture — where it sits, how it interacts

```mermaid
flowchart LR
  Caller(["caller<br/>+ identity"]) -->|"① POST /runs"| RT["<b>agent-runtime</b> — the harness (the loop)<br/>the only fully-trusted code"]
  RT -->|"② think"| GW["<b>inference-gateway</b><br/>authn · authz · budget 402 · guard<br/>holds the model credential"]
  GW <-->|"call"| Model["model<br/>(Bedrock / …)"]
  RT -->|"③ do"| SB["<b>sandbox-manager</b><br/>untrusted exec · egress lockdown"]
  RT -->|"④ remember"| ST[("<b>store</b><br/>Postgres · Redis")]
  RT -.->|"record every step"| OB["telemetry"]
```

*The runtime is the loop; ②–④ repeat until done. The gateway is the choke point — the only thing holding model credentials and the only place spend can be stopped (402). The sandbox is where untrusted code runs, never the runtime.*

---

## 8 · The same architecture, in a harness we use

```mermaid
flowchart LR
  Caller(["you<br/>in the terminal"]) -->|"① prompt"| RT["<b>opencode</b> — TUI client + server<br/>the harness (the loop)"]
  RT -->|"② think"| GW["🚫 no gateway<br/>direct provider call ·<br/>key in auth.json on your disk"]
  GW <-->|"call"| Model["model"]
  RT -->|"③ do"| SB["🚫 no sandbox<br/>your real shell + cwd ·<br/>permission prompt = manual gate"]
  RT -->|"④ remember"| ST[("local SQLite<br/>opencode.db")]
  RT -.->|"record"| OB["local log files"]
```

*Same harness, same loop — but the **entire platform layer collapsed to local** because n=1: gateway → a key on disk, sandbox → your real machine, store → one SQLite file, telemetry → a log file. The boxes that vanished are exactly the four that break at scale (slide 5). The platform **is** the gap between "opencode on my Mac" and "opencode for 200 engineers running untrusted code on a budget."*

---

## 9 · The seam — stub today, swap later

```mermaid
flowchart LR
  subgraph S["stub — start today"]
    direction TB
    s1["think · direct SDK call"]
    s2["do · local bash + temp dir"]
    s3["remember · in-memory"]
    s4["gate · allow-all + static token"]
    s5["record · console.log"]
    s6["guard · passthrough"]
  end
  subgraph R["real — swap in later"]
    direction TB
    r1["inference-gateway · budget 402 · authz"]
    r2["sandbox microVM · egress lockdown"]
    r3["Postgres + pgvector · Redis"]
    r4["TokenReview · OPA · reserve/settle"]
    r5["OTel → OpenSearch"]
    r6["Guardrails / Llama Guard"]
  end
  s1 -.->|"one env var"| r1
  s2 -.-> r2
  s3 -.-> r3
  s4 -.-> r4
  s5 -.-> r5
  s6 -.-> r6
```

*Same port, different adapter — chosen by config ([ADR-0003](decisions/0003-ports-and-adapters.md)). The craft never knows which one it's talking to.*

---

## 10 · So we build in parallel

```mermaid
flowchart TB
  subgraph C["CRAFT TRACK — start today"]
    Cc["prompts · skills · workflows · evals<br/>against stubs"]
  end
  subgraph P["PLATFORM TRACK — in parallel, underneath"]
    Pp["gateway · sandbox · store · gate · record · guard<br/>harden each adapter"]
  end
  C <==>|"meet at the ports —<br/>swap stub → real, no rewrite"| P
```

*Works only if the stubs honor the real **contract** — its failures and limits, not just the happy path: the stub `gate` must sometimes **402**, the stub `do` must **lock egress**, state must be **async** (submit→poll) from day one. Stub the happy path only and 'parallel' just defers integration to the worst possible moment.*

---

## 11 · What we're building — and what's still open

```mermaid
flowchart TB
  subgraph BUILD["What we're building"]
    B["the <b>platform</b> — the governed foundation + the harness loop,<br/>with <b>agents as the first tenant</b>, starting on stubs in parallel"]
  end
  subgraph OPEN["What we decide together — today"]
    direction TB
    O1["<b>first use case</b> — what's the first agent, and what does it produce?"]
    O2["<b>scope</b> — how far does it go? hand back a diff · merge · deploy"]
    O3["<b>autonomy</b> — human-in-the-loop · guardrailed · fully autonomous"]
    O4["<b>first slice</b> — which port gets the real adapter first (prove the seam)"]
  end
  BUILD --> OPEN
```

*The shape is settled; the boundaries are this meeting. Pick the first use case, how far it's allowed to go, and the first vertical slice — then the craft track and the platform track both start Monday.*

---

# Backup

## B1 · Why the craft isn't a primitive or a control

```mermaid
flowchart TB
  Q["&quot;Aren't skills / evals / workflows<br/>just more primitives or controls?&quot;"]
  Q --> A["<b>No — the craft is never irreducible.</b><br/>Dependencies point down: a skill imports think + do;<br/>think never imports a skill."]
  A --> C1["most craft = <b>composition</b><br/>reasoning · skills · workflows · harness<br/>are arrangements of think / do / remember<br/>→ reducible, so not a primitive"]
  A --> C2["evals = <b>meta-activity</b><br/>runs out-of-band on the <i>record</i> —<br/>not in-path, can't say no<br/>→ not a control"]
```

*Position, not function: the same LLM-judge is an **eval** scoring yesterday's runs — or, moved in-path at the gateway where it can block, it's **guard**. What makes a control is where it sits, not what it does.*

---

## B2 · Glossary — the terms, placed on the stack

```mermaid
flowchart TB
  RT["<b>reasoning techniques</b> — how you shape <i>think</i> (inside one step)"]
  SK["<b>skills</b> — packaged <i>do</i>: instructions + tools, reusable"]
  WF["<b>workflows</b> — a graph you draw up front"]
  EV["<b>evals</b> — out-of-band quality; beside the path, not in it"]
  HN["<b>harness</b> — the software that runs the loop"]
  PL["<b>platform</b> — the governed mechanism underneath"]
  RT ~~~ SK ~~~ WF ~~~ EV ~~~ HN ~~~ PL
```

*Strip the vocabulary and most of it is a way to arrange `think`, `do`, `remember`.*

---

## B3 · If not primitives, then what?

```mermaid
flowchart LR
  COMP["<b>composition</b><br/>harness · workflows"] -->|"runs / arranges"| PRIM
  PROT["<b>protocol / interface</b><br/>MCP · A2A"] -->|"plugs into"| PRIM
  CONF["<b>config / content</b><br/>skills · prompts · agent specs"] -->|"loaded to drive"| PRIM
  META["<b>meta-activity</b><br/>evals"] -->|"measures the output of"| PRIM["<b>PRIMITIVES</b><br/>think · do · remember<br/><i>irreducible mechanism, behind a port</i>"]
```

*A primitive is irreducible mechanism; everything else is defined **relative** to it — it **runs** it (harness), **plugs into** it (MCP), **packages** it (skills), or **measures** it (evals). Pull `do` out and MCP has nothing to connect to, skills nothing to invoke, the harness nothing to loop over — they can't return the favor.*
