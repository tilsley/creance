/**
 * Typed client for the agent-runtime API (the shared app.ts handler behind the
 * serverless front door). Every call carries the Cognito id token — the same
 * credential the gate verifies (ADR-0032). Types mirror core's Run/AgentSpec.
 */
import type { ConsoleConfig } from "./config";

export type RunStatus = "queued" | "running" | "completed" | "blocked" | "stuck" | "max_steps" | "failed";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResult {
  toolCallId: string;
  output: string;
}
export interface Message {
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: ToolCall[];
  results?: ToolResult[];
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  task: string;
  agent?: string;
  /** Target repo for coding runs (ADR-0034) — the resource the gate authorized. */
  repo?: string;
  principal?: { tenant: string; subject: string };
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}
export interface Run extends RunSummary {
  messages: Message[];
  output?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AgentSpec {
  name: string;
  description?: string;
  kind?: "loop" | "sandboxed" | "claude-code";
}

export interface BudgetStatus {
  tenant: string;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  ok: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    private readonly cfg: ConsoleConfig,
    private readonly token: string,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      throw new ApiError(res.status, body.error ?? `request failed (${res.status})`);
    }
    return res.json() as Promise<T>;
  }

  listRuns = () => this.req<RunSummary[]>("/runs");
  getRun = (id: string) => this.req<Run>(`/runs/${id}`);
  createRun = (task: string, agent?: string, repo?: string) =>
    this.req<{ runId: string; status: RunStatus; tenant: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({ task, ...(agent ? { agent } : {}), ...(repo ? { repo } : {}) }),
    });
  listAgents = () => this.req<AgentSpec[]>("/agents");
  budget = (tenant: string) => this.req<BudgetStatus>(`/tenants/${encodeURIComponent(tenant)}/budget`);
}
