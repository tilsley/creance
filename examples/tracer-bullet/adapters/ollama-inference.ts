/**
 * Ollama adapter for the InferenceProvider port (think) — a free, local, no-AWS
 * brain. Proves the port: same loop, different backend, selected by env.
 * Talks to Ollama's native /api/chat (tool-calling supported on Llama 3.1+,
 * Qwen2.5, etc.). Requires `ollama serve` + a tool-capable model pulled.
 */
import type {
  InferenceProvider,
  Message,
  ToolDef,
  AssistantTurn,
  ToolCall,
} from "../ports";

export class OllamaInferenceProvider implements InferenceProvider {
  readonly name = "ollama";
  readonly model: string;
  private host: string;

  constructor(model: string, host = "http://localhost:11434") {
    this.model = model;
    this.host = host.replace(/\/$/, "");
  }

  async generate(messages: Message[], tools: ToolDef[]): Promise<AssistantTurn> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: messages.flatMap(toOllama),
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);

    const data: any = await res.json();
    const msg = data.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => {
      const args = tc.function?.arguments;
      return {
        id: `${tc.function?.name ?? "tool"}-${i}`, // Ollama has no call ids; synthesize one
        name: tc.function?.name,
        input: typeof args === "string" ? JSON.parse(args) : (args ?? {}),
      };
    });
    return {
      text: msg.content || undefined,
      toolCalls,
      usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
    };
  }
}

// neutral Message -> Ollama chat message(s)
function toOllama(m: Message): any[] {
  switch (m.role) {
    case "user":
      return [{ role: "user", content: m.text }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: m.text ?? "",
          ...(m.toolCalls?.length
            ? { tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.input } })) }
            : {}),
        },
      ];
    case "tool":
      // one tool message per result (Ollama matches by name/order, no id needed)
      return m.results.map((r) => ({ role: "tool", content: r.output }));
  }
}
