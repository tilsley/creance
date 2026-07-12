/**
 * GatewayClient — the platform wire for governed think (ADR-0019/0039): verified
 * identity in, metered tokens out, no model credentials on the caller. This is
 * the exact call a delegated agent makes from inside its box, and what an
 * external agent (ADR-0040) uses from its own infra.
 *
 * Types mirror @agent-os/core's wire (Message/ToolDef/AssistantTurn) but are
 * declared here so consumers don't inherit core's adapter dependency tree —
 * the SDK is deliberately dependency-free.
 */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantTurn {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

export interface GenerateOptions {
  /** Required by the wire: the gateway reserves worst-case budget against it
   *  BEFORE invoking the model — an uncapped turn is an unbounded bill. */
  maxTokens: number;
  tools?: ToolDef[];
  /** Groups turns under one per-session budget cap (ADR-0026). */
  sessionId?: string;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`gateway returned ${status}: ${JSON.stringify(body)}`);
    this.name = "GatewayError";
  }
}

export interface GatewayClientOptions {
  /** The gateway URL (the AgentOsGateway stack output, or the chart's service). */
  gatewayUrl: string;
  /** A Bearer token, or a provider (e.g. machineTokenProvider) for long-running services. */
  token: string | (() => Promise<string>);
}

export class GatewayClient {
  private readonly base: string;
  private readonly token: () => Promise<string>;

  constructor(opts: GatewayClientOptions) {
    this.base = opts.gatewayUrl.replace(/\/$/, "");
    this.token = typeof opts.token === "string" ? async () => opts.token as string : opts.token;
  }

  /** One governed generate turn: POST /v1/generate on the platform wire. */
  async generate(messages: Message[], opts: GenerateOptions): Promise<AssistantTurn> {
    const res = await fetch(`${this.base}/v1/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: JSON.stringify({ messages, maxTokens: opts.maxTokens, tools: opts.tools, sessionId: opts.sessionId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new GatewayError(res.status, body);
    return body as AssistantTurn;
  }
}
