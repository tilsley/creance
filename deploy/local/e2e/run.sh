#!/usr/bin/env bash
# ADR-0019 local-k3s e2e (AWS-free). Builds the repo image, deploys the gateway +
# runtime + caller into colima/k3s, and runs the checks from inside the caller pod.
#   bun/Make: bash deploy/local/e2e/run.sh   (run from the repo root)
set -euo pipefail
CTX=colima
NS=agentos-e2e
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "▶ build image (agent-runtime:dev — whole repo; gateway overrides the command)"
docker build -t agent-runtime:dev -f services/agent-runtime/Dockerfile . >/dev/null

# colima's docker+k3s does NOT auto-share images: docker build updates docker's store,
# but k3s containerd keeps its own copy. Load the fresh image into k3s explicitly, else
# IfNotPresent serves a stale cached image.
echo "▶ load image into k3s containerd (colima docker+k3s doesn't auto-share)"
docker save agent-runtime:dev | colima ssh -- sudo ctr -n k8s.io images import -

echo "▶ apply stack (CRD first — avoid the CR-before-CRD-established race)"
kubectl --context "$CTX" apply -f deploy/local/e2e/stack.yaml >/dev/null 2>&1 || true
kubectl --context "$CTX" wait --for condition=established crd/tenantbindings.e2e.agent-os.io --timeout=30s >/dev/null
kubectl --context "$CTX" apply -f deploy/local/e2e/stack.yaml >/dev/null

# recreate workloads so they pick up the freshly-loaded image (same tag => no auto-roll)
echo "▶ (re)start workloads on the fresh image"
kubectl --context "$CTX" -n "$NS" rollout restart deploy/e2e-gateway deploy/e2e-runtime >/dev/null
kubectl --context "$CTX" -n "$NS" delete pod caller --ignore-not-found --wait=true >/dev/null
kubectl --context "$CTX" apply -f deploy/local/e2e/stack.yaml >/dev/null # recreate caller

echo "▶ wait for rollouts"
kubectl --context "$CTX" -n "$NS" rollout status deploy/e2e-gateway --timeout=120s
kubectl --context "$CTX" -n "$NS" rollout status deploy/e2e-runtime --timeout=120s
kubectl --context "$CTX" -n "$NS" wait --for=condition=ready pod/caller --timeout=120s

echo "▶ run e2e checks from inside the caller pod"
kubectl --context "$CTX" -n "$NS" exec -i caller -- sh -c 'cat > /tmp/check.js && bun /tmp/check.js' < deploy/local/e2e/check.js

echo "▶ (teardown: kubectl --context $CTX delete ns $NS)"
