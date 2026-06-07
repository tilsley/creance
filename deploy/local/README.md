# deploy/local — run agent-os on a local cluster

> **Namespace convention (read this first).** Local namespaces had sprawled (three
> `agentos*` namespaces) because each test script picked its own and none tore down.
> The rule now: a persistent dev deploy lives in **`agentos`**; every *test* script owns an
> **ephemeral** namespace it tears down on exit (`trap`), with `KEEP=1` to leave it for
> inspection. So `make sandbox-egress-test` / `sandbox-egress-proxy-test` no longer leave
> anything running.

Runs `agent-runtime` in-cluster on **colima + k3s** (lean, 16 GB-friendly). Two
manifests, the same you'd apply on EKS (only the local-image + creds bits differ):
- [`namespace.yaml`](namespace.yaml) — the **per-tenant isolation** set: Namespace,
  ResourceQuota, LimitRange, NetworkPolicy (the k8s side of `gate`).
- [`agent-runtime.yaml`](agent-runtime.yaml) — the **workload**: ServiceAccount,
  ConfigMap (adapter selection), Deployment (hardened), Service, HPA.

## 1. Cluster (colima ships k3s — no k3d needed)
```bash
colima start --kubernetes --cpu 2 --memory 4 --disk 20
kubectl get nodes
```

## 2. Build the image
colima wires k3s to the **docker** runtime (`kubectl get nodes -o wide` shows
`CONTAINER-RUNTIME: docker://…`), so an image built with `docker build` is already
visible to k3s — **no import, no sudo** (the Deployment uses
`imagePullPolicy: Never` so it won't reach for a registry):
```bash
docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile .
```
> On a containerd-runtime cluster (e.g. EKS, or `colima --runtime containerd`)
> you'd push to a registry / `ctr images import` instead.

## 3. Namespace + AWS creds (local only)
```bash
kubectl apply -f deploy/local/namespace.yaml
```
The pod calls Bedrock (+ DynamoDB if `RUN_STORE=dynamodb`), so give it creds via a
Secret. On EKS this is **Pod Identity** binding the ServiceAccount to the
`agent-os-runtime` IAM role — no secret (ADR-0001/0006). That keyless binding is the
**one genuinely EKS-only piece**.
```bash
kubectl -n agent-os create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)"
```
> **DynamoDB note:** the ConfigMap defaults `RUN_STORE=dynamodb`, which needs (a)
> the `agent-os-runs` table (deploy `AgentOsState` first) and (b) creds with access
> to it. If your IAM user lacks DynamoDB perms, either grant them, have the runtime
> assume the `agent-os-runtime` role, or set `RUN_STORE=memory` for a creds-light
> smoke test. `GUARDRAIL_ID` (the `AgentOsBedrock` output) enables `guard`.

The ConfigMap also sets `GATE=local` (Bearer-token auth + per-tenant budget). Provide
the tokens via a Secret (`token:tenant:subject` pairs); then calls need
`Authorization: Bearer <token>`:
```bash
kubectl -n agent-os create secret generic gate-tokens \
  --from-literal=GATE_TOKENS="tok-a:teamA:alice,tok-b:teamB:bob"
```

## 4. Deploy + test
```bash
kubectl apply -f deploy/local/agent-runtime.yaml
kubectl -n agent-os rollout status deploy/agent-runtime
kubectl -n agent-os port-forward svc/agent-runtime 3000:80 &

curl localhost:3000/healthz
ID=$(curl -s -X POST localhost:3000/runs -H 'content-type: application/json' \
  -d '{"task":"Use run_code to print 2+2."}' | bun -e 'console.log((await Bun.stdin.json()).runId)')
curl -s localhost:3000/runs/$ID            # poll until terminal
```

## Notes
- **Object set (what you're learning):** `namespace.yaml` = isolation
  (Namespace + ResourceQuota + LimitRange + NetworkPolicy); `agent-runtime.yaml` =
  workload (ServiceAccount + ConfigMap + Deployment + Service + HPA). Maps to the
  "secured by" + "scales via" columns of [resource-model.md](../../docs/resource-model.md).
- **Caveats on this cluster:** the **NetworkPolicy** isn't enforced by k3s' default
  flannel CNI (install Calico to make it bite); the **HPA** needs metrics-server
  (k3s ships it). Both are included to learn the objects.
- **Fully local (no AWS)** alternative: `INFERENCE_PROVIDER=ollama` +
  `SANDBOX_PROVIDER=local` + `RUN_STORE=memory` in the ConfigMap (drop `aws-creds`).
  Ollama must be reachable from the pod (`host.docker.internal`).
- **Logs / traces:** `kubectl -n agent-os logs deploy/agent-runtime` shows the step
  trace (`record`). Set `TELEMETRY=otel` + `OTEL_EXPORTER_OTLP_ENDPOINT` to ship.
- **Prod (EKS):** same manifests; replace `imagePullPolicy: Never` + image ref with
  an ECR image, and the `aws-creds` Secret with a **Pod Identity association**
  binding the `agent-runtime` SA → `agent-os-runtime` role (CDK StateStack).
