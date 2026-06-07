#!/usr/bin/env bash
# Egress lockdown slice 2 (ADR-0020/0022): the named-domain door.
# Proves: allowlisted domains tunnel through the proxy; non-listed are DENIED at the
# proxy (TCP_DENIED/403 in squid's log — a deliberate policy decision, not a network
# blip); a direct bypass is killed by the slice-1 wall. Two independent locks.
#   bash deploy/local/sandbox-egress-proxy-test.sh        (from the repo root)
set -euo pipefail
CTX=colima
NS=agentos-sandbox
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# ephemeral by convention — torn down on exit (KEEP=1 to inspect)
trap '[ -n "${KEEP:-}" ] || kubectl --context "$CTX" delete ns "$NS" --wait=false >/dev/null 2>&1' EXIT

echo "▶ apply slice 1 (wall) + slice 2 (proxy)"
kubectl --context "$CTX" apply -f "$ROOT/deploy/local/sandbox-egress.yaml" >/dev/null
kubectl --context "$CTX" apply -f "$ROOT/deploy/local/sandbox-egress-proxy.yaml" >/dev/null
kubectl --context "$CTX" -n "$NS" rollout status deploy/egress-proxy --timeout=90s >/dev/null
kubectl --context "$CTX" -n "$NS" wait --for=condition=ready pod/sandbox --timeout=90s >/dev/null

viaproxy() { kubectl --context "$CTX" -n "$NS" exec sandbox -- curl -s -m 12 --proxy http://egress-proxy:3128 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
direct()   { kubectl --context "$CTX" -n "$NS" exec sandbox -- curl -s -m 8 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true; }
fail()     { echo "❌ $1"; exit 1; }

echo "▶ ALLOWLISTED via proxy → reachable"
for d in registry.npmjs.org pypi.org; do
  [ "$(viaproxy https://$d/)" = "200" ] && echo "  ✅ $d = 200" || fail "$d should be allowed"
done

echo "▶ NOT allowlisted via proxy → denied"
for d in github.com evil.example; do
  c="$(viaproxy https://$d/)"
  [ "$c" = "200" ] && fail "$d should be DENIED, got 200"
  echo "  ✅ $d = blocked ($c)"
done

echo "▶ BYPASS (direct, no proxy) → wall blocks"
[ "$(direct https://registry.npmjs.org/)" = "200" ] && fail "direct egress should be blocked" || echo "  ✅ direct npmjs = blocked"

echo "▶ the door record (squid logged the decisions — status + target):"
# squid common log: $4=action/code $7=method $8=host:port (a bytes field sits at $5)
kubectl --context "$CTX" -n "$NS" exec deploy/egress-proxy -- sh -c "awk '\$7==\"CONNECT\"{print \$4, \$8}' /var/log/squid/access.log | tail -6" 2>/dev/null | sed 's/^/    /' || true
kubectl --context "$CTX" -n "$NS" exec deploy/egress-proxy -- sh -c 'grep "CONNECT github.com:443" /var/log/squid/access.log | grep -q TCP_DENIED' \
  && echo "  ✅ github.com denial is a recorded policy decision (TCP_DENIED/403), not a network error" \
  || fail "expected a TCP_DENIED record for github.com"

echo "▶ slice 2 PASS — named-domain allowlist enforced at the proxy; the wall stops the bypass"
echo "  (namespace $NS torn down on exit; re-run with KEEP=1 to inspect it)"
