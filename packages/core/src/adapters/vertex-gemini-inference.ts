/**
 * Vertex AI Gemini adapter for the InferenceProvider port (think) — the GCP-native
 * model path for the managed Agent Runtime profile (ADR-0042's GCP sibling). All
 * Gemini specifics (contents/functionCall translation, schema sanitising) are
 * confined here; the loop never sees them, exactly as the Bedrock adapter confines
 * Converse.
 *
 * Dependency-free by design: calls the regional `generateContent` REST endpoint with
 * an ADC token (the instance metadata server in-cluster; a GCP_ACCESS_TOKEN override
 * for local testing), so it adds NO google-cloud SDK weight to the shared runtime
 * image — the same stance as the DISPATCH=agentengine dispatch branch.
 *
 * Thinking is disabled by default (thinkingBudget=0): Gemini 2.5 spends output tokens
 * on hidden reasoning, which would make the maxTokens cap (ADR-0013) stop bounding the
 * *visible* completion and can starve the answer. Set VERTEX_THINKING_BUDGET to re-enable.
 */
import type {
  InferenceProvider,
  GenerateOptions,
  Message,
  ToolDef,
  AssistantTurn,
  ToolCall,
} from "../ports";

/** ADC token for generateContent — explicit override first (local/testing), else the
 *  instance metadata server (works when running on GCP as the runtime's service account). */
async function gcpAccessToken(): Promise<string> {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`GCP metadata token fetch failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export class VertexGeminiInferenceProvider implements InferenceProvider {
  readonly name = "vertex-gemini";
  readonly model: string;
  private readonly endpoint: string;
  private readonly thinkingBudget: number;

  constructor(model: string, project: string, location: string, thinkingBudget = 0) {
    this.model = model;
    this.thinkingBudget = thinkingBudget;
    this.endpoint =
      `https://${location}-aiplatform.googleapis.com/v1` +
      `/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
  }

  async generate(messages: Message[], tools: ToolDef[], opts: GenerateOptions): Promise<AssistantTurn> {
    // Gemini keys tool results to their call by function NAME, not id — build id→name
    // from the assistant turns so a neutral tool result can name its function.
    const nameById = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "assistant") for (const tc of m.toolCalls ?? []) nameById.set(tc.id, tc.name);
    }

    const body: Record<string, unknown> = {
      contents: messages.map((m) => toGemini(m, nameById)),
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
        thinkingConfig: { thinkingBudget: this.thinkingBudget },
      },
      ...(tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: sanitizeSchema(t.inputSchema),
                })),
              },
            ],
          }
        : {}),
    };

    const token = await gcpAccessToken();
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`vertex gemini generateContent ${res.status}: ${await res.text().catch(() => "")}`.trim());
    }
    const data: any = await res.json();

    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    let text: string | undefined;
    const toolCalls: ToolCall[] = [];
    for (const p of parts) {
      if (typeof p.text === "string") text = (text ?? "") + p.text;
      if (p.functionCall) {
        toolCalls.push({
          id: crypto.randomUUID(), // Gemini returns no call id; synthesise (results map back by name)
          name: p.functionCall.name,
          input: (p.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }
    const um = data?.usageMetadata ?? {};
    return {
      text,
      toolCalls,
      usage: { inputTokens: um.promptTokenCount, outputTokens: um.candidatesTokenCount },
    };
  }
}

// neutral Message -> Gemini Content
function toGemini(m: Message, nameById: Map<string, string>): any {
  switch (m.role) {
    case "user":
      return { role: "user", parts: [{ text: m.text }] };
    case "assistant": {
      const parts: any[] = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls ?? []) parts.push({ functionCall: { name: tc.name, args: tc.input } });
      return { role: "model", parts };
    }
    case "tool":
      // Gemini takes tool results as a user turn of functionResponse parts, keyed by name.
      return {
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            name: nameById.get(r.toolCallId) ?? r.toolCallId,
            response: { result: r.output },
          },
        })),
      };
  }
}

// Gemini's function `parameters` is an OpenAPI-3 subset, not full JSON Schema; drop the
// keywords it rejects so an existing ToolDef schema passes through unchanged otherwise.
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(["$schema", "$id", "$defs", "definitions", "additionalProperties"]);
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) if (!drop.has(k)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(schema) as Record<string, unknown>;
}
