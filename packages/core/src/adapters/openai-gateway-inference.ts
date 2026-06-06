/**
 * OpenAIGatewayInferenceProvider — the client side of an OpenAI-compatible gateway
 * (LiteLLM, ADR-0024/0026). The sibling of GatewayInferenceProvider: same job (the runtime
 * holds no model creds; the gateway authenticates the caller, enforces budget, calls the
 * model), different wire — it POSTs `/v1/chat/completions` in OpenAI shape instead of the
 * bespoke `/v1/generate`. Behind the same `InferenceProvider` port, so the loop is agnostic;
 * config.ts picks the wire by `INFERENCE_GATEWAY_WIRE` (bespoke = Bun gateway, openai = LiteLLM).
 *
 * It translates our neutral conversation types ↔ OpenAI JSON, forwards the caller's identity
 * as the bearer (so the gateway derives the tenant — ADR-0019/M2), and maps 401/402 to the
 * same errors the in-process admission path throws, so callers stay agnostic.
 */
import type { InferenceProvider, Message, ToolDef, GenerateOptions, AssistantTurn, ToolCall } from "../ports";
import { UnauthorizedError, BudgetExceededError, type BudgetStatus } from "../gate";

export interface OpenAIGatewayOptions {
  /** the caller's identity token, forwarded so the gateway authenticates + derives tenant. */
  token?: string;
  /** tenant hint (informational; the gateway authoritatively derives tenant from the token). */
  tenant?: string;
  /** run/session id — sent as metadata so the gateway can enforce the per-session cap. */
  sessionId?: string;
}

export class OpenAIGatewayInferenceProvider implements InferenceProvider {
  readonly name = "openai-gateway";
  readonly model: string;
  private readonly url: string;

  constructor(gatewayUrl: string, model: string, private readonly opts: OpenAIGatewayOptions = {}) {
    this.url = gatewayUrl.replace(/\/$/, "");
    this.model = model;
  }

  async generate(messages: Message[], tools: ToolDef[], opts: GenerateOptions): Promise<AssistantTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiMessages(messages),
      max_tokens: opts.maxTokens,
    };
    const oaTools = toOpenAiTools(tools);
    if (oaTools) body.tools = oaTools;
    if (this.opts.sessionId) body.metadata = { session_id: this.opts.sessionId };

    const res = await fetch(`${this.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) throw new UnauthorizedError("inference gateway rejected the caller");
    if (res.status === 402) {
      const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string }; budget?: BudgetStatus };
      throw new BudgetExceededError(
        detail.budget ?? ({ tenant: this.opts.tenant ?? "?", limitUsd: 0, spentUsd: 0, remainingUsd: 0, ok: false }),
      );
    }
    if (!res.ok) throw new Error(`inference gateway error: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());

    return fromOpenAiResponse((await res.json()) as OpenAiChatResponse);
  }
}

// --- wire translation: our neutral types ↔ OpenAI chat-completions ----------
type OpenAiChatResponse = {
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function toOpenAiMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text });
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.text ?? null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        }));
      }
      out.push(msg);
    } else {
      // one OpenAI `tool` message per result (our single tool turn can carry several)
      for (const r of m.results) out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.output });
    }
  }
  return out;
}

function toOpenAiTools(tools: ToolDef[]): unknown[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function fromOpenAiResponse(data: OpenAiChatResponse): AssistantTurn {
  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: safeParseObject(tc.function.arguments),
  }));
  return {
    text: msg.content ?? undefined,
    toolCalls,
    usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
  };
}

function safeParseObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
