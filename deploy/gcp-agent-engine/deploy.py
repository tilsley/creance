#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["google-cloud-aiplatform>=1.112.0"]
# ///
"""Deploy the agent-runtime container to GCP Vertex **Agent Runtime** and smoke it.

The GCP sibling of ADR-0042's AgentCore deploy. The image is built + pushed by
Cloud Build (cloudbuild.yaml); this creates the managed runtime from that image,
overriding the command to the agent-engine.ts entrypoint ("fourth entrypoint, same
image"), then runs a probe query to prove the invoke path.

    # deploy (build first with cloudbuild.yaml)
    uv run deploy/gcp-agent-engine/deploy.py deploy
    # smoke an existing engine
    uv run deploy/gcp-agent-engine/deploy.py query --engine <RESOURCE_NAME> --probe
    uv run deploy/gcp-agent-engine/deploy.py query --engine <RESOURCE_NAME> --task "say hi"

NOTE: the exact container_spec sub-fields (command/env/ports) for Agent Runtime BYOC
are under-documented; the agent-engine.ts entrypoint LOGS every invocation so the
first live deploy reveals the true contract. Adjust CONTAINER_SPEC below to match.
"""
import argparse
import json
import sys

PROJECT = "decent-decker-270921"
LOCATION = "europe-west2"
IMAGE = "europe-west2-docker.pkg.dev/decent-decker-270921/agent-os/agent-runtime:latest"
SERVICE_ACCOUNT = "agent-runtime@decent-decker-270921.iam.gserviceaccount.com"

# Reasoning-engine container_spec takes ONLY the image (no command/env override — the
# API exposes neither). Everything else is steered by env_vars: the CMD indirection
# selects the agent-engine.ts entrypoint (AGENT_ENTRYPOINT), the runtime hosts the loop
# (DISPATCH=inprocess), and INFERENCE_PROVIDER=vertex points the loop at Gemini on Vertex
# (GCP-native, ADC auth via the runtime service account — no key). GATE is left unset →
# open authn, since the :query call is already GCP-IAM-gated at the platform; per-tenant
# gate/budget wiring (identity → tenant) is a later phase.
ENV_VARS = {
    "AGENT_ENTRYPOINT": "services/agent-runtime/agent-engine.ts",
    "DISPATCH": "inprocess",
    "INFERENCE_PROVIDER": "vertex",
    # GOOGLE_CLOUD_PROJECT is a RESERVED var the platform injects — config.ts reads it.
    "GCP_LOCATION": LOCATION,
    "VERTEX_MODEL": "gemini-2.5-flash",
    # The default agentcore sandbox needs AWS creds (unavailable on GCP); `local` runs in
    # the session's own microVM — fine for the spike (the demo task calls no tools). A GCP
    # sandbox (Code Execution / Sandbox BYOC) adapter is a later phase.
    "SANDBOX_PROVIDER": "local",
    "AIP_HTTP_PORT": "8080",
}


def client():
    import vertexai

    return vertexai.Client(project=PROJECT, location=LOCATION)


def deploy(_args) -> None:
    c = client()
    print(f"creating Agent Runtime from {IMAGE} ...", file=sys.stderr)
    engine = c.agent_engines.create(
        config={
            "display_name": "agent-os-loop",
            "description": "agent-os L1 loop on Vertex Agent Runtime (ADR-0042 GCP sibling)",
            "container_spec": {"image_uri": IMAGE},
            "env_vars": ENV_VARS,
            "service_account": SERVICE_ACCOUNT,
            "min_instances": 0,  # scale to zero — the cost-sensitive win
            "max_instances": 1,
        }
    )
    name = getattr(engine, "resource_name", None) or getattr(engine, "name", None) or str(engine)
    print(f"created: {name}")
    print("smoke it:  uv run deploy/gcp-agent-engine/deploy.py query --engine "
          f"{name} --probe", file=sys.stderr)


def query(args) -> None:
    # A custom/BYOC container has class_methods=None, so the SDK exposes no .query()
    # helper. Call the reasoningEngine :query REST method directly — the platform POSTs
    # our `input` to the container at POST /api/reasoning_engine and relays the
    # container's `{"output": ...}` body back as the :query response (verified 2026-07-14).
    import urllib.request
    import google.auth
    import google.auth.transport.requests

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    payload = {"input": {"probe": True} if args.probe else {"task": args.task}}
    url = f"https://{LOCATION}-aiplatform.googleapis.com/v1/{args.engine}:query"
    print(f"POST {url}\n  {payload}", file=sys.stderr)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {creds.token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        print(json.dumps(json.load(r), indent=2))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("deploy")
    q = sub.add_parser("query")
    q.add_argument("--engine", required=True, help="reasoningEngine resource name")
    q.add_argument("--probe", action="store_true", help="probe mode (no model call)")
    q.add_argument("--task", default="say hello in five words", help="a real task to run")
    args = ap.parse_args()
    {"deploy": deploy, "query": query}[args.cmd](args)


if __name__ == "__main__":
    main()
