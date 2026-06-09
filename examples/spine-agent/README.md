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

## In k3s — the full spine, real Kubernetes identity (`k8s-pod.yaml`)

`k8s-pod.yaml` runs the spine **as a pod** with a **projected ServiceAccount token** (audience
`agent-os-gateway`) — no model creds, no auth code. It calls the in-cluster `litellm-gateway`
(deployed by [`charts/litellm-gateway`](../../charts/litellm-gateway)), which verifies the token
against the **cluster JWKS**, derives the tenant from `sub`, checks the claim/budget, and calls
Bedrock. Validated end to end on colima/k3s: `status=completed`, output `Paris`.

```bash
# gateway up (real SA tokens + a claim for the agent's SA) + creds for Bedrock:
make k8s-creds   # but into agentos-gw; see the spine k8s notes
helm install litellm-gateway charts/litellm-gateway -n agentos-gw --create-namespace \
  --set-string 'env.CLAIMS_STATIC={"system:serviceaccount:agentos-gw:spine-agent":{"model":"claude-haiku","monthlyBudgetUsd":5}}'
kubectl apply -n agentos-gw -f examples/spine-agent/k8s-pod.yaml
kubectl -n agentos-gw logs spine-agent
```

The agent presents an identity it never had to *verify*; the gateway does all the auth — and the
agent's own code (and process) carries none of it. Without a mesh, the gateway self-verifies via
JWKS (cheap mode); with Istio/Linkerd it'd trust a mesh-forwarded identity instead (full mode,
`MeshTrustAuthenticator`) — same `Authenticator` port, no agent/gateway change.
