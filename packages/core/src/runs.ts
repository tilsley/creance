/**
 * Runs — the State primitive's first concrete use (`remember`). A Run is a
 * persisted, asynchronously-processed unit of work: the runtime creates it
 * (queued), a worker executes it (running → terminal), persisting conversation +
 * status as it goes. Behind a RunStore port so the backing is swappable
 * (in-memory for dev → DynamoDB / AgentCore Memory in prod).
 *
 * Tenant/principal/spend fields are added by the `gate` control (#3) later.
 */
import type { Message, TokenUsage } from "./ports";
import type { Principal } from "./gate";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "blocked" | "stuck";

export interface Run {
  id: string;
  status: RunStatus;
  task: string;
  /** Which registered agent this run executes as (agent control plane, #5). */
  agent?: string;
  /** Target repo ("owner/name") for coding runs (ADR-0034) — a caller-chosen
   *  RESOURCE authorized at the gate, not agent config. The egress sidecar pins
   *  its credential allowlist to this after the run is admitted. */
  repo?: string;
  /** Who the run acts as (gate, ADR-0009). Absent under the open NoopGate. */
  principal?: Principal;
  messages: Message[];
  output?: string;
  error?: string;
  /** Accumulated token usage + costed spend (gate budget accounting). */
  usage?: TokenUsage;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunStore {
  readonly name: string;
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | undefined>;
  update(id: string, patch: Partial<Run>): Promise<Run>;
  /** For startup reconciliation (e.g. re-queue/abandon interrupted runs). */
  listByStatus(status: RunStatus): Promise<Run[]>;
  /** Recent runs, newest first — for the dashboard / observability. */
  list(limit?: number): Promise<Run[]>;
}

export class InMemoryRunStore implements RunStore {
  readonly name = "memory";
  private runs = new Map<string, Run>();

  async create(run: Run): Promise<void> {
    this.runs.set(run.id, run);
  }

  async get(id: string): Promise<Run | undefined> {
    return this.runs.get(id);
  }

  async update(id: string, patch: Partial<Run>): Promise<Run> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`run not found: ${id}`);
    const next: Run = { ...run, ...patch, updatedAt: new Date().toISOString() };
    this.runs.set(id, next);
    return next;
  }

  async listByStatus(status: RunStatus): Promise<Run[]> {
    return [...this.runs.values()].filter((r) => r.status === status);
  }

  async list(limit = 100): Promise<Run[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
