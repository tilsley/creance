/**
 * GatewayInferenceProvider — the client side of the inference gateway (ADR-0019).
 * Implements the InferenceProvider port by forwarding `generate` to the standalone
 * gateway over HTTP instead of calling Bedrock in-process. The runtime therefore holds
 * NO model credentials — the gateway is the sole holder of bedrock:InvokeModel, and
 * budget/isolation are enforced there (unbypassable). The caller's identity rides in the
 * Authorization bearer so the gateway can re-derive the tenant (non-forgeable) and assume
 * that tenant's role.
 *
 * Wire it by setting INFERENCE_GATEWAY_URL (config.ts) — then `inferenceForTenant`
 * returns this instead of the in-process assume-role Bedrock provider.
 */
import type { InferenceProvider, Message, ToolDef, GenerateOptions, AssistantTurn } from "../ports";
import { UnauthorizedError, BudgetExceededError, type BudgetStatus } from "../gate";

export interface GatewayInferenceOptions {
  /** the caller's identity token, forwarded so the gateway authenticates + derives tenant. */
  token?: string;
  /** tenant hint (informational; the gateway authoritatively derives tenant from the token). */
  tenant?: string;
}

export class GatewayInferenceProvider implements InferenceProvider {
  readonly name = "gateway";
  readonly model: string;
  private readonly url: string;

  constructor(gatewayUrl: string, model: string, private readonly opts: GatewayInferenceOptions = {}) {
    this.url = gatewayUrl.replace(/\/$/, "");
    this.model = model;
  }

  async generate(messages: Message[], tools: ToolDef[], opts: GenerateOptions): Promise<AssistantTurn> {
    const res = await fetch(`${this.url}/v1/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify({ messages, tools, maxTokens: opts.maxTokens }),
    });

    if (res.status === 401) throw new UnauthorizedError("inference gateway rejected the caller");
    if (res.status === 402) {
      // surface the same error the in-process admission path throws, so callers are agnostic
      const body = (await res.json().catch(() => ({}))) as { budget?: BudgetStatus };
      throw new BudgetExceededError(body.budget ?? ({ tenant: this.opts.tenant ?? "?", limitUsd: 0, spentUsd: 0, remainingUsd: 0, ok: false }));
    }
    if (!res.ok) throw new Error(`inference gateway error: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());

    const turn = (await res.json()) as AssistantTurn;
    return { text: turn.text, toolCalls: turn.toolCalls ?? [], usage: turn.usage };
  }
}
