/**
 * agent-runtime lambda — the front door on AWS Lambda WITHOUT an HTTP server
 * (ADR-0031, "purpose-built handler"). No Bun.serve, no Lambda Web Adapter: this
 * is a native Lambda Runtime API client. Bun provides Request/Response/fetch, so
 * it runs the SAME createApp() handler server.ts serves — only the loop around it
 * differs. That keeps the front door byte-identical across substrates, the way
 * process-run.ts is byte-identical across executors.
 *
 * The loop (the Lambda "custom runtime" contract):
 *   GET  /runtime/invocation/next            → block until an invocation arrives
 *   → convert the Function URL (payload v2) event into a Web Request
 *   → run app(req) → convert the Response back
 *   POST /runtime/invocation/{id}/response   → hand the result back
 *   POST /runtime/invocation/{id}/error      → on a handler throw
 * Lambda sets AWS_LAMBDA_RUNTIME_API=host:port and execs this as the image CMD.
 *
 * Wire it with DISPATCH=runtask + the ECS_* env the ServerlessStack outputs, so
 * POST /runs launches a Fargate task-per-run (dispatch.ts). This process holds no
 * run — it gates, creates the queued record, and hands off.
 */
import { providersFromEnv } from "@agent-os/core";
import { createApp } from "./app";

const API = process.env.AWS_LAMBDA_RUNTIME_API;
if (!API) {
  console.error("agent-runtime lambda: AWS_LAMBDA_RUNTIME_API not set — run me on Lambda (or the RIE).");
  process.exit(2);
}
const base = `http://${API}/2018-06-01/runtime`;

/** Report a fatal init failure to Lambda, then exit — the platform recycles us. */
async function initError(e: unknown): Promise<never> {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`agent-runtime lambda: init failed: ${message}`);
  await fetch(`${base}/init/error`, {
    method: "POST",
    headers: { "Lambda-Runtime-Function-Error-Type": "Runtime.InitError" },
    body: JSON.stringify({ errorType: "InitError", errorMessage: message }),
  }).catch(() => {});
  process.exit(1);
}

// Build providers + the handler ONCE (cold start); a failure here (e.g.
// DISPATCH=runtask without the ECS_* wiring) is an init error, not a per-request one.
const app = await (async () => {
  const providers = providersFromEnv(); // once per process (OTel registers globally)
  const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined;
  console.log(
    `agent-runtime lambda: ready (dispatch=${process.env.DISPATCH ?? "inprocess"}; ` +
      `store=${providers.runStore.name}; gate=${providers.gate.name}; ` +
      `authn=${providers.authenticator.name} authz=${providers.authorizer.name})`,
  );
  return createApp(providers, { maxOutputTokens, a2aAgent: process.env.A2A_AGENT });
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
  // host is irrelevant to routing (app.ts reads only url.pathname), but URL needs one.
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

// The invocation loop: next → handle → response/error, forever. A handler throw is
// per-request (report it, keep the process for the next invocation); only init fails hard.
while (true) {
  const next = await fetch(`${base}/invocation/next`);
  const requestId = next.headers.get("lambda-runtime-aws-request-id");
  if (!requestId) {
    console.error("agent-runtime lambda: /invocation/next had no request id; retrying");
    continue;
  }
  try {
    const event = await next.json();
    const res = await app(eventToRequest(event));
    const result = await responseToResult(res);
    await fetch(`${base}/invocation/${requestId}/response`, { method: "POST", body: JSON.stringify(result) });
  } catch (e: any) {
    console.error(`agent-runtime lambda: invocation ${requestId} failed: ${e?.message ?? e}`);
    await fetch(`${base}/invocation/${requestId}/error`, {
      method: "POST",
      headers: { "Lambda-Runtime-Function-Error-Type": "Handler.Error" },
      body: JSON.stringify({ errorType: "HandlerError", errorMessage: String(e?.message ?? e) }),
    }).catch(() => {});
  }
}
