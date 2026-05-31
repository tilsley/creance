/**
 * AdmissionInferenceProvider — the cost hard-stop (ADR-0013), as a decorator over
 * the InferenceProvider port. It wraps any inner provider (Bedrock today, LiteLLM
 * later) and, on every turn, prices the request's WORST case *before* sending:
 *
 *     worst = price(inputTokens) + price(maxTokens of output)
 *
 * Input tokens are knowable now (the prompt is in hand); output is bounded by the
 * required `maxTokens` cap. If admitting the request would push the tenant's
 * cumulative spend over its cap, we refuse — nothing is sent, nothing is spent.
 * This is what stops a single $50 one-shot that pure post-hoc accounting can't.
 *
 * Bound to one tenant, so the runtime builds it PER RUN (keeps the port pure — no
 * tenant in `generate`'s signature). Records actual spend per turn on the way out.
 */
import type { InferenceProvider, GenerateOptions, Message, ToolDef, AssistantTurn } from "../ports";
import { type Gate, BudgetExceededError, estimateCostUsd, priceTokensUsd } from "../gate";

export class AdmissionInferenceProvider implements InferenceProvider {
  readonly name: string;
  readonly model: string;

  constructor(
    private readonly inner: InferenceProvider,
    private readonly gate: Gate,
    private readonly tenant: string,
    /** run/session id — also enforces the per-session cap, if one is configured (ADR-0019). */
    private readonly scopeId?: string,
  ) {
    this.name = `admission(${inner.name})`;
    this.model = inner.model;
  }

  async generate(messages: Message[], tools: ToolDef[], opts: GenerateOptions): Promise<AssistantTurn> {
    const scopes = { sessionId: this.scopeId };
    // 1. price the worst case: real input + the full output cap
    const worstUsd = priceTokensUsd(this.model, estimateInputTokens(messages, tools), opts.maxTokens);
    // 2. ATOMICALLY reserve the worst case across every scope (tenant/month + session) —
    //    closes the check-then-add race; refuse pre-flight if any scope would breach.
    const reservation = await this.gate.reserve(this.tenant, worstUsd, scopes);
    if (!reservation.ok) throw new BudgetExceededError(reservation);
    // 3. admit — the real model call. On failure, fully refund (the call cost nothing).
    let turn: AssistantTurn;
    try {
      turn = await this.inner.generate(messages, tools, opts);
    } catch (e) {
      await this.gate.settle(this.tenant, -worstUsd, scopes).catch(() => {});
      throw e;
    }
    // 4. settle the reservation down to actual cost (delta is usually negative)
    await this.gate.settle(this.tenant, estimateCostUsd(this.model, turn.usage) - worstUsd, scopes);
    return turn;
  }
}

/**
 * Rough input-token estimate for pre-flight pricing. A ~4-chars/token heuristic
 * over all text in the conversation + tool schemas — no tokenizer dependency. POC:
 * swap for a model-specific tokenizer (or the gateway's count) for tighter bounds.
 */
export function estimateInputTokens(messages: Message[], tools: ToolDef[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.role === "user") chars += m.text.length;
    else if (m.role === "assistant") {
      chars += (m.text ?? "").length;
      for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.input).length;
    } else {
      for (const r of m.results) chars += r.output.length;
    }
  }
  for (const t of tools) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 4);
}
