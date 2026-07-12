# ADR-0043: The spec-first edge — pure OpenAPI contracts, API Gateway, custom domains

- **Status:** Proposed
- **Date:** 2026-07-12

## Context

Both public surfaces (the front door, [0031](0031-serverless-substrate-for-the-run-loop.md);
the inference gateway, [0039](0039-gateway-on-the-serverless-substrate.md)) sat on bare
Lambda Function URLs: unstable hostnames, publicly invokable transport, and — the deeper
gap — **no written contract**. The platform API existed only as code, when
[0038](0038-agent-onboarding-behind-the-gate.md)'s whole lesson was that the API server
is the platform.

The operator wanted custom domains (`api.creance.nathantilsley.com` /
`inference.creance.nathantilsley.com`) and brought a proven spec-first pattern from
janey-the-artist: an OpenAPI document driving both API Gateway (`SpecRestApi`) and
generated TypeScript types (`openapi-typescript`). A prior objection — API Gateway
buffers Lambda responses, killing 0039's deferred streaming path — **expired in Nov 2025**:
REST APIs now stream (`STREAM` response transfer mode, 15-min integration timeout, >10 MB
payloads), so the streaming graduation is a mode flag on the same box, not a re-architecture.

### The janey pattern, critiqued (what we keep, what we fix)

Keep: spec-first `SpecRestApi`, edge request validation, generated types, custom domain +
alias records. Fix:

1. **Logical-ID overrides + `Fn::Sub` in the spec** — stringly-typed coupling between the
   contract and CDK internals (a renamed construct is a runtime 500). Instead the AWS
   integration is injected **at synth** from the real `functionArn`.
2. **~40% machine noise** (CORS mocks, response-param boilerplate) burying the contract —
   generated at synth instead; the YAML stays purely semantic.
3. **APIGW-flavored spec** — with `x-amazon-apigateway-*` baked in, the file can't
   describe the pod profile ([0027](0027-two-deployment-profiles.md)) or feed docs
   cleanly. Ours are pure OpenAPI.
4. **`failOnWarnings: false`** — defeats the point; ours is `true`.
5. **Side-effectful type generation** (installs deps inside the build, commits + rebuilds) —
   ours is a plain devDependency, generated output committed, exported as source.
6. **No spec↔server enforcement** — types flow to clients but nothing proves the Lambda
   implements the contract. We add a **contract test** that walks the spec and drives the
   real app factory in-process.

## Decision

**Each service keeps a PURE OpenAPI contract next to its code; a synth-time overlay turns
it into an API Gateway REST API on a custom subdomain; the spec generates the SDK's types
and is enforced by an in-process contract test. Function URLs are retired.**

- **Contracts:** `services/agent-runtime/openapi.yaml` (runs, agents, tenants, A2A) and
  `services/inference-gateway/openapi.yaml` (generate, messages, claims). No AWS
  extensions — the same file describes the pod and the Lambda deployments.
- **The overlay** (`infra/lib/spec-rest-api.ts`, `SpecRestApiEdge`): parses the YAML at
  synth (Bun's built-in parser — the CDK app runs under bun) and injects per operation an
  `aws_proxy` integration to the service's ONE router Lambda — **app-layer routing and
  auth are unchanged** ([0026](0026-gateway-hot-path-authn-authz-budget.md)); the edge
  adds request-BODY validation (malformed payloads die before a cold start), OPTIONS
  methods, `failOnWarnings: true`, a regional ACM cert (DNS-validated), the domain, and
  the Route 53 alias. Domains/zone live in `cdk.json` context, never `-c` flags.
- **No raw URL remains:** API Gateway invokes the Lambda by service integration, so with
  the Function URLs deleted the only transport is the domain. (The Function URL fallback
  survives in code for context-less synth only.)
- **CORS moved into the app** (`withCors`, @agent-os/core): it used to live on the
  Function URL config — substrate-specific; now the app answers preflight and stamps
  headers identically on pod, Lambda, and edge. Edge-generated errors (validation 400s)
  get the header via gateway responses.
- **Types:** `@agent-os/client`'s wire types are now ALIASES of the generated contract
  types (`src/generated.ts`, committed) — the SDK cannot drift from the spec.
- **Contract test** (`openapi-contract.test.ts`): walks every operation, drives the real
  `createGatewayApp` in-process, asserts each route exists and answers only declared
  statuses (including 401 for every `security`-marked op). Add a route without amending
  the spec — or vice versa — and tests fail before any deploy.
- **Lambda loop:** `eventToRequest` now accepts REST API (payload 1.0) events alongside
  Function URL 2.0 — both entrypoints, kept mirrored.

### Alternatives considered

- **CloudFront + OAC over Function URLs**: cheaper (free tier vs ~$3.50/M), locks the raw
  URL rather than deleting it, and was the right answer while API Gateway couldn't
  stream. Post-Nov-2025 the REST API wins: no raw URL at all, native domain + throttling
  + WAF seat, streaming via a mode flag, and the spec-first contract for free.
- **HTTP API (v2)**: cheaper than REST but no response streaming, no request validation,
  and weaker OpenAPI import — the three features this ADR exists for.
- **Edge JWT authorizer**: tempting with Cognito wired, but it would split authn across
  two layers and break the composite (0041's M2M tokens have no `aud`). Identity stays
  app-layer; the edge validates shape only.

## Consequences

- Stable, memorable addresses; the console/config.json and `AGENT_GATEWAY_URL` pick them
  up through the existing stack-output flow. Clients change nothing (discovery via
  config.json) except any hardcoded lambda-url values.
- The platform finally has a reviewable API surface — and a place where API *changes* are
  visible in diffs, which is most of what a contract buys a solo operator.
- Costs: ~$3.50/M requests + a few cents of Route 53 queries; idle cost unchanged (~$0).
- Streaming ([0039](0039-gateway-on-the-serverless-substrate.md) open item) is now "flip
  the operation's transfer mode to STREAM + use the streaming runtime API" — same edge.
- The front door's spec has no contract test yet (its app factory needs a fuller
  Providers mock) — the gateway's proves the pattern; port it when the front door's
  surface next changes.

## Relationship

Hardens [0039](0039-gateway-on-the-serverless-substrate.md)'s transport and retires its
streaming caveat; gives [0038](0038-agent-onboarding-behind-the-gate.md)'s API-server
thesis a written constitution; feeds [0040](0040-coded-agents-services-vs-libraries.md)'s
SDK from the contract instead of hand-rolled types. One-liner: **the contract is pure,
the wiring is synthesized, the types are generated, and the test proves the app tells the
truth.**
