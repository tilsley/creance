#!/usr/bin/env bash
# Egress-lockdown slice 1 (ADR-0020/0022): the wall holds, the door works.
# Proves on local k3s (kube-router NetworkPolicy): sandbox → gateway = OK;
# sandbox → internet = blocked; DNS still resolves (so we blocked egress, not DNS).
#   bash deploy/local/sandbox-egress-test.sh        (from the repo root)
set -euo pipefail
CTX=colima
NS=agentos-sandbox
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# convention: local test namespaces are EPHEMERAL — torn down on exit so they don't sprawl.
# Set KEEP=1 to leave the namespace up for inspection.
trap '[ -n "${KEEP:-}" ] || kubectl --context "$CTX" delete ns "$NS" --wait=false >/dev/null 2>&1' EXIT

echo "▶ apply the wall + doors + gateway stand-in + sandbox pod"
kubectl --context "$CTX" apply -f "$ROOT/deploy/local/sandbox-egress.yaml" >/dev/null
kubectl --context "$CTX" -n "$NS" rollout status deploy/gateway --timeout=90s >/dev/null
kubectl --context "$CTX" -n "$NS" wait --for=condition=ready pod/sandbox --timeout=90s >/dev/null

code() { kubectl --context "$CTX" -n "$NS" exec sandbox -- curl -s -m 6 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
fail() { echo "❌ $1"; exit 1; }

echo "▶ POSITIVE — the one allowed door (needs DNS to resolve the service too)"
[ "$(code http://gateway)" = "200" ] && echo "  ✅ sandbox → gateway = 200" || fail "gateway door should be 200"

echo "▶ NEGATIVE — egress lockdown blocks the internet"
for url in https://1.1.1.1 https://example.com http://github.com; do
  c="$(code "$url")"
  [ "$c" = "200" ] && fail "EGRESS LEAK: $url returned 200 — the wall is down"
  echo "  ✅ sandbox → $url = blocked ($c)"
done

echo "▶ CONTROL — DNS still resolves (proves we blocked egress, not DNS)"
kubectl --context "$CTX" -n "$NS" exec sandbox -- nslookup example.com >/dev/null 2>&1 \
  && echo "  ✅ DNS resolves" || fail "DNS should resolve"

echo "▶ slice 1 PASS — no anonymous egress: think-works / exfil-dies"
echo "  (namespace $NS torn down on exit; re-run with KEEP=1 to inspect it)"
