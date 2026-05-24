/**
 * Ports — the provider-agnostic interfaces the agent loop depends on (ADR-0003).
 * No AWS / SDK types leak through here. Adapters (see adapters/) implement these;
 * the loop (loop.ts) imports ONLY this file.
 */

// --- neutral conversation types (no provider shapes) -------------------------
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
}

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface AssistantTurn {
  text?: string;
  toolCalls: ToolCall[];
}

// --- think: the Inference primitive port -------------------------------------
export interface InferenceProvider {
  readonly name: string;
  /** Given the conversation so far + available tools, produce the next turn. */
  generate(messages: Message[], tools: ToolDef[]): Promise<AssistantTurn>;
}

// --- do: the Sandbox primitive port ------------------------------------------
export interface SandboxSession {
  readonly id: string;
  /** Execute code, return its stdout. */
  runCode(code: string): Promise<string>;
  close(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  startSession(): Promise<SandboxSession>;
}
