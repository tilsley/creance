/**
 * POST /v1/messages — the Anthropic-wire endpoint (ADR-0028), so unmodified
 * Anthropic-speaking clients (Claude Code, OpenCode/@ai-sdk, Anthropic SDKs) get
 * governed inference: verified identity → claim (default-deny) → worst-case reserve
 * → Bedrock InvokeModel passthrough → settle to actual.
 *
 * Passthrough by design: the body is the native Anthropic Messages body (we only move
 * `model` to the URL, add `anthropic_version`, and scrub client-SDK skew), and the
 * streamed chunks are re-emitted verbatim as Anthropic-dialect SSE. No translation
 * layer to chase Anthropic features with.
 *
 * Budget rules ported from the LiteLLM hook findings (commit c07766a):
 *  - settle exactly ONCE per reservation (pop-once), whichever path finishes first;
 *  - a stream the client abandons stays spent at worst-case (over-charge, never a
 *    budget hole);
 *  - pre-flight failures refund fully (the call cost nothing).
 */
import type { Authenticator, Gate, InferenceClaim } from "@agent-os/core";
import { UnauthorizedError, priceTokensUsd } from "@agent-os/core";
import type { AnthropicUpstream, AnthropicEvent } from "./bedrock-anthropic";

export interface MessagesDeps {
  authenticator: Authenticator;
  gate: Gate;
  upstream: AnthropicUpstream;
  /** Resolve the caller's claim (ADR-0021). When configured, no claim ⇒ 403 —
   *  default-deny in BOTH profiles (ADR-0028 closes the cheap-mode flat-budget gap). */
  claimFor?: (serviceAccount: string) => Promise<InferenceClaim | undefined>;
  /** Map a claim/body model name (alias or id) to the Bedrock model id to invoke. */
  resolveModel: (model?: string) => string | undefined;
}

const bearer = (req: Request): string | undefined => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

export async function handleMessages(req: Request, deps: MessagesDeps): Promise<Response> {
  // 1. authenticate → principal (tenant is non-forgeable, derived here)
  let principal;
  try {
    principal = await deps.authenticator.authenticate({ credential: bearer(req), headers: Object.fromEntries(req.headers) });
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }

  // 2. parse + validate the Anthropic body. max_tokens is load-bearing: it bounds the
  //    worst-case reserve (R2) — absent ⇒ 400, same contract as the LiteLLM hooks.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) return Response.json({ error: "missing 'messages' (array)" }, { status: 400 });
  if (typeof body.max_tokens !== "number") return Response.json({ error: "max_tokens is required" }, { status: 400 });
  const maxTokens = body.max_tokens;

  // 3. claim → model routing (the claim wins over the body) + default-deny
  let claim: InferenceClaim | undefined;
  if (deps.claimFor) {
    claim = await deps.claimFor(principal.subject);
    if (!claim) return Response.json({ error: `no inference claim for '${principal.subject}'` }, { status: 403 });
  }
  const modelId = deps.resolveModel(claim?.model ?? (typeof body.model === "string" ? body.model : undefined));
  if (!modelId) return Response.json({ error: "no model: name one in the claim or request" }, { status: 400 });

  // 4. worst-case reserve, atomic, multi-scope (tenant/month + session — ADR-0019)
  const meta = body.metadata as { user_id?: unknown } | undefined;
  const scopes = { sessionId: typeof meta?.user_id === "string" ? meta.user_id : undefined };
  const worstUsd = priceTokensUsd(modelId, estimateAnthropicInputTokens(body), maxTokens);
  const reservation = await deps.gate.reserve(principal.tenant, worstUsd, scopes);
  if (!reservation.ok) return Response.json({ error: "budget exceeded", budget: reservation }, { status: 402 });

  // pop-once settle: whichever completion path runs first wins; the rest are no-ops.
  let settled = false;
  const settleOnce = (deltaUsd: number) => {
    if (settled) return;
    settled = true;
    void deps.gate.settle(principal.tenant, deltaUsd, scopes).catch(() => {});
  };

  const upstreamBody = toBedrockBody(body);

  // 5a. non-streaming: invoke, settle to actual, return the Anthropic body verbatim
  if (body.stream !== true) {
    let resp: Record<string, unknown>;
    try {
      resp = await deps.upstream.invoke(modelId, principal.tenant, upstreamBody);
    } catch (e) {
      settleOnce(-worstUsd); // nothing reached the model bill — full refund
      return upstreamError(e);
    }
    const usage = resp.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    settleOnce(priceTokensUsd(modelId, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0) - worstUsd);
    return Response.json(resp);
  }

  // 5b. streaming: open the upstream BEFORE responding (so validation errors are JSON,
  //     not a broken SSE), then re-emit each Anthropic event verbatim as SSE.
  const abort = new AbortController();
  let events: AsyncIterable<AnthropicEvent>;
  try {
    events = await deps.upstream.invokeStream(modelId, principal.tenant, upstreamBody, abort.signal);
  } catch (e) {
    settleOnce(-worstUsd);
    return upstreamError(e);
  }

  const enc = new TextEncoder();
  let inputTokens = 0;
  let outputTokens: number | undefined; // undefined until the stream reports usage
  const settleToUsage = () => {
    // no usage observed ⇒ leave the reservation spent (over-charge, never a hole)
    if (outputTokens !== undefined) settleOnce(priceTokensUsd(modelId, inputTokens, outputTokens) - worstUsd);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of events) {
          // usage facts: input arrives on message_start, cumulative output on message_delta
          if (ev.type === "message_start") {
            const u = (ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
            if (typeof u?.input_tokens === "number") inputTokens = u.input_tokens;
          } else if (ev.type === "message_delta") {
            const u = ev.usage as { output_tokens?: number } | undefined;
            if (typeof u?.output_tokens === "number") outputTokens = u.output_tokens;
          }
          controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        }
        settleToUsage();
        controller.close();
      } catch (e) {
        settleToUsage(); // mid-stream fault: settle to what the stream reported, if anything
        controller.error(e);
      }
    },
    cancel() {
      // client walked away: kill the upstream call; the reservation stays spent (c07766a)
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * Native Anthropic body → the Bedrock-Anthropic body: `model`/`stream` move to the
 * call, `anthropic_version` is required, `metadata` is not in Bedrock's schema (its
 * user_id already became our session scope), and known client-SDK skew is scrubbed —
 * Bedrock 400s "Extra inputs are not permitted" on fields it doesn't know (the
 * compat_hook lesson: `eager_input_streaming` from @ai-sdk/anthropic ≥1.16).
 */
export function toBedrockBody(body: Record<string, unknown>): Record<string, unknown> {
  const { model: _model, stream: _stream, metadata: _metadata, ...rest } = body;
  const out: Record<string, unknown> = { ...rest, anthropic_version: BEDROCK_ANTHROPIC_VERSION };
  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as Record<string, unknown>[]).map(({ eager_input_streaming: _e, ...tool }) => tool);
  }
  return out;
}

/**
 * Rough input-token estimate for the worst-case reserve — the same ~4-chars/token
 * heuristic as admission-inference.ts, over the Anthropic body's prompt-bearing parts.
 */
export function estimateAnthropicInputTokens(body: Record<string, unknown>): number {
  const chars = (v: unknown) => (v == null ? 0 : JSON.stringify(v).length);
  return Math.ceil((chars(body.system) + chars(body.messages) + chars(body.tools)) / 4);
}

/** Map upstream failures: Bedrock validation → 400 (the client sent a bad body);
 *  everything else → 502 with the detail (the gateway itself is fine). */
function upstreamError(e: unknown): Response {
  const err = e as { name?: string; message?: string };
  if (err?.name === "ValidationException") return Response.json({ error: err.message ?? "invalid request" }, { status: 400 });
  return Response.json({ error: "inference failed", detail: err?.message }, { status: 502 });
}
