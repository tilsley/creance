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

echo "▶ apply the InferenceClaim CRD (ADR-0021) + wait established, then the stack"
kubectl --context "$CTX" apply -f deploy/local/claim-crd.yaml >/dev/null
for i in 1 2 3 4 5; do # the just-created CRD's Established condition can lag a beat
  kubectl --context "$CTX" wait --for condition=established crd/inferenceclaims.agent-os.io --timeout=10s >/dev/null 2>&1 && break || sleep 2
done
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

# ADR-0021: claims are validated by the API server (CEL + OpenAPI patterns), no controller.
# Prove a bad claim is refused at apply time — sessionBudget > monthlyBudget trips the CEL rule.
echo "▶ slice 5    invalid claim rejected at apply time (CEL, no controller):"
BAD=$(kubectl --context "$CTX" apply --dry-run=server -f - 2>&1 <<'YAML' || true
apiVersion: agent-os.io/v1alpha1
kind: InferenceClaim
metadata: { name: bad }
spec: { tenant: teama, serviceAccount: "system:serviceaccount:agentos-e2e:caller", monthlyBudgetUsd: "1", sessionBudgetUsd: "5" }
YAML
)
echo "$BAD" | grep -qi "sessionBudgetUsd must not exceed" \
  && echo "✅ rejected by CEL: sessionBudgetUsd must not exceed monthlyBudgetUsd" \
  || { echo "❌ expected CEL rejection, got: $BAD"; exit 1; }

echo "▶ (teardown: kubectl --context $CTX delete ns $NS; kubectl --context $CTX delete -f deploy/local/claim-crd.yaml)"
