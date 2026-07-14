# GCP Agent Runtime deploy — the fourth profile (phase 1)

The GCP sibling of the AWS AgentCore managed profile ([ADR-0042](../../docs/decisions/0042-agentcore-managed-profile.md)).
Hosts the L1 loop on **Vertex Agent Runtime** (Gemini Enterprise Agent Platform) instead of
Fargate/EKS/AgentCore — same contract, same invariant shell, selected by env bundle
([ADR-0027](../../docs/decisions/0027-two-deployment-profiles.md)). Resource-model map:
[`docs/agent-engine-service-comparison.md`](../../docs/agent-engine-service-comparison.md).

## Layout

| Piece | Where |
|---|---|
| Plumbing (Artifact Registry, loop SA, IAM) | `infra-gcp/` (Pulumi, GCS-backed state) |
| Container entrypoint (in-runtime executor) | `services/agent-runtime/agent-engine.ts` |
| Front-door dispatch branch | `services/agent-runtime/dispatch.ts` → `DISPATCH=agentengine` |
| Image build (amd64, → Artifact Registry) | `cloudbuild.yaml` |
| Deploy + smoke | `deploy.py` (uv) |

## Prereqs (one-time, already done 2026-07-14)

- Project `decent-decker-270921` (creance), billing on, region `europe-west2` (mirrors AWS eu-west-2).
- APIs: aiplatform, artifactregistry, cloudbuild, secretmanager, run, iam.
- `cd infra-gcp && PULUMI_CONFIG_PASSPHRASE="" pulumi up` → Artifact Registry repo + `agent-runtime` SA.

## Deploy

```bash
# 1. build + push the image (linux/amd64, native on Cloud Build)
gcloud builds submit --config deploy/gcp-agent-engine/cloudbuild.yaml \
  --project=decent-decker-270921 .

# 2. create the managed runtime from that image (overrides command → agent-engine.ts)
uv run deploy/gcp-agent-engine/deploy.py deploy

# 3. smoke the invoke path — probe mode needs no model creds
uv run deploy/gcp-agent-engine/deploy.py query --engine <RESOURCE_NAME> --probe
```

## The empirical-contract note

The exact in-container HTTP contract for Agent Runtime BYOC (the route Agent Runtime POSTs
to, the request/response JSON, the port env) is under-documented. `agent-engine.ts` therefore:

- listens on `AIP_HTTP_PORT` (default 8080) on `0.0.0.0`,
- answers health on `AIP_HEALTH_ROUTE` (+ `/`, `/ping`),
- **logs every invocation** (`agent-engine invoke: <method> <path> body=…`),
- defaults to **probe mode** (returns a runtime envelope, no model call) when the input has no `task`.

So the first live deploy is self-verifying: read the runtime logs to learn the true route/body,
then tighten `agent-engine.ts` and `CONTAINER_SPEC` in `deploy.py`. This closes open-question #1
in the service-comparison ledger.

## Status (2026-07-14)

- ✅ Plumbing live; entrypoint + dispatch written and **locally smoked** (health + probe).
- ✅ Image builds + pushes to Artifact Registry via Cloud Build (~60s, amd64).
- ✅ **Deploy schema learned empirically** (this was the point):
  - `container_spec` on a reasoning engine takes **only `image_uri`** — no `command`, no `env`.
  - There is **no command-override field anywhere** → the container's own CMD must launch the
    entrypoint. Hence the Dockerfile CMD is now an env-indirection (`AGENT_ENTRYPOINT`), and the
    deploy sets it via `env_vars` (the faithful "one image, env-selected entrypoint").
  - `env_vars` (dict), `service_account`, `min_instances`/`max_instances` are top-level on
    `AgentEngineConfig`; `agent_server_mode` is STABLE/EXPERIMENTAL (API stability, not a mode).
  - The `create()` call **validates and begins provisioning**, then fails with **code 13
    (INTERNAL)** at the container/health stage. Container stdout does not surface via `gcloud
    logging` filters (engine is rolled back on failure).
- ⏳ **NEXT — debug the code-13 provisioning failure.** Hypotheses, cheapest first:
  1. **Port contract** — Agent Runtime likely injects its own `AIP_HTTP_PORT` / probes a
     specific port; our `env_vars` pin `AIP_HTTP_PORT=8080` and the base image sets `PORT=3000`.
     Confirm which port the platform probes; make `agent-engine.ts` bind exactly that.
  2. **Service account** — the passed `agent-runtime` SA may need extra bindings (the deploy did
     `SetIamPolicy`); retry with the **default** SA to isolate.
  3. **Logs** — read container logs in the **Cloud Console** Agent Engine page (surfaces more
     than `gcloud logging read`), and the [troubleshooting guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/troubleshooting/agent-deployment).
  4. **Health contract** — confirm the health path Agent Runtime probes; `agent-engine.ts`
     answers `/healthz`, `/`, `/ping` — widen if needed.
  The probe/echo mode + request logging in `agent-engine.ts` are built precisely to read the
  true contract off the first *successful* boot; closing this closes ledger open-question #1.
