/**
 * inference-gateway lambda — the gateway on AWS Lambda WITHOUT an HTTP server
 * (ADR-0039; a line-for-line mirror of services/agent-runtime/lambda.ts, which
 * established the pattern in ADR-0031). Native Runtime API loop: no Bun.serve, no
 * Lambda Web Adapter — Bun gives us Request/Response/fetch, so this runs the SAME
 * createGatewayApp() handler server.ts serves; only the loop around it differs.
 */
import { providersFromEnv } from "@agent-os/core";
import { createGatewayApp } from "./app";

const API = process.env.AWS_LAMBDA_RUNTIME_API;
if (!API) {
  console.error("inference-gateway lambda: AWS_LAMBDA_RUNTIME_API not set — run me on Lambda (or the RIE).");
  process.exit(2);
}
const base = `http://${API}/2018-06-01/runtime`;

async function initError(e: unknown): Promise<never> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`inference-gateway lambda: init failed: ${message}`);
  await fetch(`${base}/init/error`, {
    method: "POST",
    headers: { "Lambda-Runtime-Function-Error-Type": "Runtime.InitError" },
    body: JSON.stringify({ errorType: "InitError", errorMessage: message }),
  }).catch(() => {});
  process.exit(1);
}

// Build providers + the handler ONCE (cold start); init failures are init errors.
const app = await (async () => {
  const providers = providersFromEnv(); // once per process (OTel registers globally)
  console.log(
    `inference-gateway lambda: ready (authn=${providers.authenticator.name}; gate=${providers.gate.name}; ` +
      `inference=${providers.inference.name} model=${providers.inference.model})`,
  );
  return createGatewayApp(providers);
})().catch(initError);

/** Function URL / API Gateway HTTP API (payload format 2.0) event → Web Request. */
function eventToRequest(event: any): Request {
  const method: string = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const rawPath: string = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const qs: string = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v != null) headers.set(k, String(v));
  let body: string | undefined = event.body ?? undefined;
  if (body != null && event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
  const bodyless = method === "GET" || method === "HEAD";
  return new Request(`https://lambda.local${rawPath}${qs}`, {
    method,
    headers,
    body: bodyless ? undefined : body,
  });
}

/** Web Response → the Function URL result shape Lambda expects. */
async function responseToResult(res: Response) {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { statusCode: res.status, headers, body: await res.text(), isBase64Encoded: false };
}

// The invocation loop: next → handle → response/error, forever.
while (true) {
  const next = await fetch(`${base}/invocation/next`);
  const requestId = next.headers.get("lambda-runtime-aws-request-id");
  if (!requestId) {
    console.error("inference-gateway lambda: /invocation/next had no request id; retrying");
    continue;
  }
  try {
    const event = await next.json();
    const res = await app(eventToRequest(event));
    const result = await responseToResult(res);
    await fetch(`${base}/invocation/${requestId}/response`, { method: "POST", body: JSON.stringify(result) });
  } catch (e: any) {
    console.error(`inference-gateway lambda: invocation ${requestId} failed: ${e?.message ?? e}`);
    await fetch(`${base}/invocation/${requestId}/error`, {
      method: "POST",
      headers: { "Lambda-Runtime-Function-Error-Type": "Handler.Error" },
      body: JSON.stringify({ errorType: "HandlerError", errorMessage: String(e?.message ?? e) }),
    }).catch(() => {});
  }
}
