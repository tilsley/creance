# Sandbox egress lockdown — slice 1 (the wall)

The `do` containment control (ADR-0020/0022). The invariant: **no anonymous egress** —
a sandbox gets zero internet by default; the only way out is a named, policied door.

```
  agentos-sandbox namespace
  ├─ NetworkPolicy default-deny-egress   ← the WALL: all pods, deny all egress
  ├─ NetworkPolicy allow-dns             ← DOOR 1: kube-dns only (no open :53 tunnel)
  ├─ NetworkPolicy allow-sandbox→gateway ← DOOR 2: app=sandbox → app=gateway:80 only
  ├─ gateway (nginx stand-in for the inference gateway)
  └─ sandbox pod (Model B stand-in: curl + sleep)
```

## Run it

```bash
bash deploy/local/sandbox-egress-test.sh     # or: make sandbox-egress-test
# teardown: kubectl --context colima delete ns agentos-sandbox
```

Proves: `sandbox → gateway = 200` (the door + DNS), `sandbox → {1.1.1.1, example.com,
github.com} = blocked`, and DNS still resolves (so egress was blocked, not DNS broken).

## Model A vs Model B (ADR-0020)

Same wall, different door set:
- **Model A** (loop-as-app): the sandbox runs only untrusted code and never thinks → door
  set is **empty** (or registry-only). Delete the `allow-sandbox-to-gateway` policy and you
  have it: zero egress.
- **Model B** (agent-in-box, e.g. Claude Code): the harness thinks *inside* the box → the
  gateway door is **required** (the one this slice opens). Egress lockdown is the
  load-bearing control here because there's no trusted app to lean on.

## Why this works on k3s (where the runtime's egress policy didn't)

k3s enforces NetworkPolicy via built-in kube-router. The `agent-runtime` couldn't take a
tight egress policy because it needs the **k8s API server** (`10.43.0.1 → host:6443` DNAT,
which port-based egress doesn't match — see `namespace.yaml`). A **sandbox has no
API-server need**, so default-deny egress is clean here. Pod-backed ClusterIP services
(the gateway, kube-dns) match egress policy fine post-DNAT; only the host-network API path
was the problem.

## Next slices

1. **Egress proxy + allowlist** — named outbound domains (npm/PyPI registry, your git host)
   via a forward proxy, so real coding agents work without reopening the wall. Allowed
   domains are still exfil channels (a commit to an allowed git host leaks) → per-tenant
   risk dial, with `guard` + `record` watching the doors.
2. **Research-as-a-tool** — `web_search`/`fetch_url` execute *outside* the sandbox behind
   the tool gateway; content comes back through `guard` (inbound injection vector). The
   sandbox keeps zero egress.
3. **Runtime isolation** — gVisor/Kata `RuntimeClass` on EKS (the kernel/VM boundary the
   network wall complements); E2B / AgentCore as managed adapters (ADR-0022).
