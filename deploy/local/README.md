# deploy/local — run agent-os on a local cluster

Runs `agent-runtime` in-cluster on **colima + k3s** (lean, 16 GB-friendly). The
manifest ([`agent-runtime.yaml`](agent-runtime.yaml)) is the same you'd apply on
EKS — only the local-image bits differ (see notes).

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

## 3. AWS creds (local only)
The pod calls Bedrock + AgentCore, so give it creds via a Secret. (On EKS this is
**Pod Identity**, not a secret — see ADR-0001/0006.)
```bash
kubectl create namespace agent-os --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agent-os create secret generic aws-creds \
  --from-literal=AWS_ACCESS_KEY_ID="$(aws configure get aws_access_key_id)" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$(aws configure get aws_secret_access_key)"
```

## 4. Deploy + test
```bash
kubectl apply -f deploy/local/agent-runtime.yaml
kubectl -n agent-os rollout status deploy/agent-runtime
kubectl -n agent-os port-forward svc/agent-runtime 3000:80 &

curl localhost:3000/healthz
curl -s -X POST localhost:3000/runs -H 'content-type: application/json' \
  -d '{"task":"Use run_code to print 2+2."}'
```

## Notes
- **Fully local (no AWS)** alternative: set `INFERENCE_PROVIDER=ollama` +
  `SANDBOX_PROVIDER=local` in the Deployment env (drop the `aws-creds` secret).
  Note Ollama must be reachable from the pod (`host.docker.internal` or the host
  IP), and `local` sandbox runs code in the pod — fine for a throwaway cluster.
- **Logs / traces:** `kubectl -n agent-os logs deploy/agent-runtime` shows the
  step trace (the `record` control). Set `TELEMETRY=otel` +
  `OTEL_EXPORTER_OTLP_ENDPOINT` to ship to a collector.
- **Prod (EKS):** same manifest; replace `imagePullPolicy: Never` + image ref with
  an ECR image, and the `aws-creds` Secret with EKS Pod Identity.
