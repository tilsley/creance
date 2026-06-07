# spine-agent — the platform's smallest end-to-end test

The first **real agent** run through the whole platform (not curl): a `runAgent` loop that
thinks once, through the governed gateway, and returns.

```
runAgent (L1 loop)  →  OpenAIGatewayInferenceProvider (M4)  →  LiteLLM gateway  →  Bedrock
   holds NO model creds        forwards the agent's identity     authn + budget      Haiku
```

```bash
make spine-agent        # or: bash examples/spine-agent/run.sh "your question"
```

Proven: `status=completed`, the answer comes back, and the telemetry shows
`inference=openai-gateway` — i.e. the model call left the runtime, went through the gateway
(which authenticated `bob`, checked the claim/budget, and called Bedrock with *its* creds), and
the agent never touched a model credential. Spend is trivial (Haiku, ~$0.00003/turn) and settles
to the `agent-os-budgets` counter.

**What it exercises:** L1 loop · the M4 OpenAI-wire gateway adapter · M2 verified-identity authn ·
M1 worst-case budget admission · guard (noop here) · record (console). Think-only (`tools: () => []`)
so it isolates the spine; the research / budget-buster / code agents layer `do` and the 402 on top.
