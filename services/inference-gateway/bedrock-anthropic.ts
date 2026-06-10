/**
 * Bedrock upstream for the Anthropic passthrough wire (ADR-0028). Claude models on
 * Bedrock accept the NATIVE Anthropic Messages body (with `anthropic_version` added and
 * `model` moved to the URL), and InvokeModelWithResponseStream chunks are literal
 * Anthropic events inside AWS event-stream framing. So this stays a thin transport:
 * per-tenant client (assume-role when configured, ADR-0014), invoke, decode chunk JSON.
 * All wire/budget logic lives in messages.ts behind the AnthropicUpstream seam, so the
 * handler is unit-testable without AWS.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { TenantCredentials } from "@agent-os/core";

/** One decoded Anthropic streaming event (message_start, content_block_delta, ...). */
export interface AnthropicEvent {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicUpstream {
  /** Non-streaming invoke: returns the parsed Anthropic response body verbatim. */
  invoke(modelId: string, tenant: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Streaming invoke: yields decoded Anthropic events. `signal` aborts the upstream
   *  call when the client disconnects (the abandoned-stream rule, ADR-0028). */
  invokeStream(
    modelId: string,
    tenant: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<AnthropicEvent>>;
}

export class BedrockAnthropicUpstream implements AnthropicUpstream {
  /** Per-tenant clients: the assume-role provider inside caches + refreshes its creds. */
  private readonly clients = new Map<string, BedrockRuntimeClient>();

  constructor(
    private readonly region: string,
    private readonly tenantCredentials?: TenantCredentials,
  ) {}

  private async clientFor(tenant: string): Promise<BedrockRuntimeClient> {
    const creds = await this.tenantCredentials?.forTenant(tenant);
    const key = creds ? tenant : ""; // ambient creds share one client
    let client = this.clients.get(key);
    if (!client) {
      client = new BedrockRuntimeClient({ region: this.region, ...(creds ? { credentials: creds } : {}) });
      this.clients.set(key, client);
    }
    return client;
  }

  async invoke(modelId: string, tenant: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = await this.clientFor(tenant);
    const resp = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      }),
    );
    return JSON.parse(new TextDecoder().decode(resp.body));
  }

  async invokeStream(
    modelId: string,
    tenant: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<AnthropicEvent>> {
    const client = await this.clientFor(tenant);
    const resp = await client.send(
      new InvokeModelWithResponseStreamCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      }),
      { abortSignal: signal },
    );
    const events = resp.body;
    if (!events) throw new Error("Bedrock returned no response stream");
    const decoder = new TextDecoder();
    return (async function* () {
      for await (const item of events) {
        if (item.chunk?.bytes) yield JSON.parse(decoder.decode(item.chunk.bytes)) as AnthropicEvent;
        // non-chunk members are mid-stream faults (modelStreamError ...) — surface them
        else if (Object.keys(item).length) throw new Error(`bedrock stream error: ${JSON.stringify(item)}`);
      }
    })();
  }
}
