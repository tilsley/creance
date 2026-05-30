/**
 * ScriptedInferenceProvider — a deterministic InferenceProvider for demos/tests.
 * It emits a fixed sequence of turns, advancing by the number of tool results seen
 * so far: turn[0] on the first call, turn[1] after one tool result, etc. Each turn
 * is either a tool call or final text. No model, no network — the run is fully
 * reproducible, which is what lets the A2A demo drive real runtimes without Bedrock.
 *
 *   INFERENCE_PROVIDER=scripted
 *   SCRIPTED_TURNS='[{"tool":"call_agent","input":{"agent":"enrich-bot","task":"file it"}},{"text":"delegated"}]'
 */
import type { InferenceProvider, GenerateOptions, Message, ToolDef, AssistantTurn } from "../ports";

export type ScriptedTurn = { tool: string; input: Record<string, unknown> } | { text: string };

export class ScriptedInferenceProvider implements InferenceProvider {
  readonly name = "scripted";
  readonly model: string;

  constructor(private readonly turns: ScriptedTurn[], model = "scripted") {
    this.model = model;
  }

  async generate(messages: Message[], _tools: ToolDef[], _opts: GenerateOptions): Promise<AssistantTurn> {
    const step = messages.filter((m) => m.role === "tool").length;
    const turn = this.turns[Math.min(step, this.turns.length - 1)];
    const usage = { inputTokens: 50, outputTokens: 20 };
    if (turn && "tool" in turn) {
      return { toolCalls: [{ id: `tc-${step}`, name: turn.tool, input: turn.input }], usage };
    }
    return { text: (turn as { text?: string })?.text ?? "done", toolCalls: [], usage };
  }
}
