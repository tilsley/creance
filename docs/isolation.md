# Sandbox isolation: running untrusted agent code

This is the hardest and most expensive part of `agent-os`. This document records
the analysis behind our isolation choices so the reasoning survives.

> **Outcome:** we offload this entirely to **AWS Bedrock AgentCore** (managed
> Firecracker-per-session) — see [ADR-0006](decisions/0006-agentcore-execution-environment.md).
> The analysis below is retained as the *rationale* for that choice, and as the
> playbook if execution is ever in-sourced.

## Why a plain container is not enough

A standard container (`runc`) is just a Linux process wearing costumes:
namespaces (what it sees), cgroups (what it uses), seccomp + capabilities (which
syscalls it may make). It talks **directly to the host kernel** — the same kernel
every other tenant's pod shares. The attack surface is the *entire* syscall
interface (350+ syscalls, plus `/proc`, `/sys`, ioctls). One reachable kernel bug
= container escape = host compromise = lateral movement to other teams' workloads.
Dirty COW, Dirty Pipe, and assorted io_uring CVEs were all container-escape
vectors.

We run **untrusted, agent-generated code**, so neutralizing that shared kernel is
mandatory. Two approaches:

## Option A — gVisor (`runsc`): a kernel in userspace

Google's Linux-compatible kernel, written in Go, running as a normal userspace
process. The sandboxed code's syscalls are intercepted and serviced by gVisor's
**Sentry** instead of the host kernel; the Sentry itself makes only a small,
locked-down set of real host syscalls. Host kernel attack surface shrinks from
"everything" to "the narrow slice the Sentry uses."

- **Pieces:** *Sentry* (userspace kernel), *Gofer* (mediates filesystem access
  over 9P/LISAFS), and a *platform* for trapping syscalls — `ptrace` (compatible,
  slow), `KVM`, or `systrap` (newer, faster).
- **Runs on normal EC2.** No bare metal, no nested virtualization. Fast start
  (hundreds of ms), high density.
- **Catches:**
  - **Syscall-compat gaps.** gVisor reimplements Linux, not 100% of it. Exotic
    things break — some io_uring, certain `/proc`+`/sys` reads, odd ioctls, some
    networking, weak GPU passthrough. For arbitrary agent code you can't predict
    what it touches.
  - **Overhead** on syscall- and I/O-heavy workloads (interception + 9P tax,
    lower net throughput). CPU-bound code is fine.
  - **No managed path on EKS.** Install the `containerd-shim-runsc-v1` shim +
    `runsc` binary on each node, add a `runsc` runtime to containerd's
    `config.toml`, register a `RuntimeClass`. Via custom AMI or bootstrap. Light,
    but DIY. (GKE has this as a checkbox — "GKE Sandbox"; EKS does not.)

## Option B — Kata Containers + Firecracker: a real microVM per pod

Each pod runs inside an actual lightweight VM with **its own guest kernel**,
hardware-isolated via KVM. Kata makes the VM behave like a pod to Kubernetes
(`containerd-shim-kata-v2`); the VMM underneath is **Firecracker** (AWS's minimal
microVM — what Lambda/Fargate use), Cloud Hypervisor, or QEMU.

- **Strongest isolation.** The workload talks to its *own* guest kernel, not the
  host's. Escape requires breaking the VM boundary (a KVM/VMM 0-day) — far harder.
- **Full compatibility.** Real kernel → arbitrary code "just works."
- **The catch that dominates everything — nested virtualization:**
  - KVM needs hardware virt extensions (VT-x/AMD-V). On AWS, **normal EC2
    instances are themselves Nitro VMs and do not expose nested virt** — you
    cannot run Firecracker inside an `m6a.large`.
  - Only real option on AWS: **bare-metal instances** (`*.metal`). Expensive,
    slow to provision (minutes), thinner spot market, pay for the whole box.
  - **Lower density / higher per-sandbox cost** — every microVM reserves its own
    kernel + memory.

## The cross-cloud nested-virt fact

The "bare-metal team" problem is largely a way to dodge **AWS specifically**:

- **GCP and Azure support nested virtualization on many standard VM types** — you
  can run KVM/Firecracker inside a normal VM.
- **AWS does not** (except `.metal`).

So Firecracker shops either own physical metal (Fly.io) or run on GCP nested-virt
VMs (E2B). Choosing **gVisor sidesteps this entirely** — it's a userspace process
on any VM.

## Are there off-the-shelf AMIs?

No first-party AWS AMI ships either runtime preinstalled (AL2023 / Bottlerocket
give `runc` only). For both, you bake a custom AMI (Packer / EC2 Image Builder on
the EKS-optimized AMI) or install at boot.

- **gVisor:** light — binary + shim + containerd config + RuntimeClass. Bottlerocket
  is immutable, so use an AL2023-based custom AMI. Runs on normal instances.
- **Kata/Firecracker:** heavy — needs `kata-runtime`, Firecracker, a guest kernel,
  a minimal rootfs, and shim wiring — *and still requires `.metal`*. The AMI just
  packages the assembly; it doesn't fix the hardware constraint.

## The tech is old; the demand is new

microVM / userspace-kernel sandboxing was invented for **serverless and
multi-tenant cloud, ~2017–2018**, years before the AI wave:

- **KVM** (Linux hardware virtualization) — 2007.
- **Kata Containers** — Dec 2017 (Intel Clear Containers + Hyper runV).
- **gVisor** — open-sourced May 2018 (Google; App Engine / Cloud Run / GKE).
- **Firecracker** — re:Invent Nov 2018 (AWS, for Lambda/Fargate; forked from
  Google's `crosvm`). Lambda has since run trillions of invocations on it.

**AI changed the market, not the technology.** "Run arbitrary untrusted code at
scale" was a niche owned by serverless platforms, CI runners, and online judges.
Now every coding agent / code-interpreter generates untrusted code that must run
isolated — so a niche infra concern became mainstream (2023+), spawning the
sandbox-as-a-service category.

## Solved vs. unsolved

- **Solved (mature):** the isolation primitives themselves. Firecracker, gVisor,
  Kata are production-grade. "Can I isolate untrusted code?" — yes.
- **Not solved:**
  1. Easy, self-service, portable deployment — no turnkey "Lambda-grade sandbox
     for your own cluster."
  2. Cloud portability (the nested-virt split above).
  3. Cold-start vs density vs compatibility — a tradeoff triangle nobody wins.
  4. GPU-in-microVM — genuinely immature.

**AWS does provide microVM isolation — as Lambda and Fargate** (Fargate runs each
pod in its own Firecracker microVM). It deliberately does **not** expose
Firecracker as an EKS `RuntimeClass` (operational complexity + competes with
Lambda/Fargate). And EKS-on-Fargate is too restrictive for a sandbox platform
(no Karpenter, DaemonSets, privileged pods, GPUs, or custom runtimes). So the gap
is real for *self-operated* sandbox infra.

## What the sandbox companies do

*(Confidence: high on E2B / Fly / the AWS-vs-GCP nested-virt split; medium-high on
Modal=gVisor; lower on Daytona/Northflank internals — verify before relying.)*

| Provider | Isolation | Bare metal? | Open source? |
|---|---|---|---|
| **E2B** | Firecracker | Ran on GCP (nested virt on normal VMs) | **Yes** — `e2b-dev/infra` (Apache-2.0); closest self-hostable Firecracker stack |
| **Fly.io (Machines)** | Firecracker | **Yes — own datacenters** | Mostly proprietary; some components open |
| **Modal** | **gVisor** (custom runtime) | No | Proprietary; good engineering blogs |
| **Daytona** | Containers / own orchestrator | n/a | Open-source roots; sandbox product newer |
| **Northflank** | Secure container runtime | — | Proprietary PaaS |

The **runtimes are all open source** (`firecracker`, `firecracker-containerd`,
`kata-containers`, `gvisor`). The **orchestration is the moat**: fast cold starts
(Firecracker snapshot/restore), rootfs minimization, per-sandbox networking +
egress control, scheduling, GPU passthrough, quota/billing.

## Decision

See [ADR-0006](decisions/0006-agentcore-execution-environment.md). We **offload
untrusted execution to AWS Bedrock AgentCore** (managed Firecracker-per-session),
rather than running it in our own cluster. This gives VM-grade isolation with zero
idle cost and removes the entire build burden analyzed above.

**Egress control is still part of isolation.** A microVM boundary stops *escape*,
not *exfiltration* — configure AgentCore's network mode (sandboxed vs allowlisted)
per the workload.

### If execution is ever in-sourced (superseded plan, ADR-0002)

The prior plan, kept as a fallback behind the `SandboxProvider` port:
- `runc` — trusted internal/platform services (Tier 0)
- `gvisor` — default for untrusted agent code (Tier 1), on normal Karpenter nodes
- `kata`/`firecracker` — high-assurance (Tier 2) on `.metal`, only if truly needed
  (and then prefer E2B's open stack or a non-AWS host over hand-rolling).

## References (to verify before relying)

- gVisor — <https://gvisor.dev>
- Firecracker — <https://firecracker-microvm.github.io>
- Kata Containers — <https://katacontainers.io>
- AWS Fargate microVM isolation; AWS nested-virt limitations (`.metal` only)
- GCP / Azure nested virtualization on standard VM types
- E2B open infra — `github.com/e2b-dev/infra`
