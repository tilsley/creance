/**
 * Agents — the agent control plane's data model (#5). An AgentSpec is a
 * *declarative agent definition* (name, tenant, model, systemPrompt, allowed
 * tools, maxSteps); the L1 runtime resolves one per run via the AgentRegistry and
 * applies it. This is the **catalog** half (agent-registry — read by the runtime);
 * the reconciler (agent-controller) is separate. See ADR-0012.
 *
 * Behind a port like everything else: an in-memory registry for dev → a k8s
 * CRD-backed registry (Agent custom resources) in cluster.
 */
export interface AgentSpec {
  name: string;
  /** Owning tenant (gate). */
  tenant?: string;
  /** Model override (else the runtime default). */
  model?: string;
  systemPrompt?: string;
  /** Allowed tool / MCP-server names (policy). Empty/undefined = whatever's configured. */
  tools?: string[];
  maxSteps?: number;
  /**
   * Execution kind (ADR-0019). "loop" (default) = the runtime drives the think/do loop.
   * "sandboxed" = a self-contained delegated agent runs inside the sandbox; its inference
   * routes to the gateway (the agent speaks to the gateway), its execution stays in the
   * sandbox. No new primitive — just a different `do` shape.
   * "claude-code" (ADR-0033) = the run IS one headless Claude Code invocation in its own
   * Fargate task (the harness owns think+do); serverless dispatch only — it selects a
   * different task definition, everything upstream (gate, run store, polling) is unchanged.
   */
  kind?: "loop" | "sandboxed" | "claude-code";
  /** For kind="sandboxed": the command that launches the delegated agent in the sandbox. */
  command?: string;
}

export interface AgentRegistry {
  readonly name: string;
  get(name: string): Promise<AgentSpec | undefined>;
  list(): Promise<AgentSpec[]>;
}

export class InMemoryAgentRegistry implements AgentRegistry {
  readonly name = "memory";
  private readonly agents = new Map<string, AgentSpec>();
  constructor(seed: AgentSpec[] = []) {
    for (const a of seed) this.agents.set(a.name, a);
  }
  async get(name: string): Promise<AgentSpec | undefined> {
    return this.agents.get(name);
  }
  async list(): Promise<AgentSpec[]> {
    return [...this.agents.values()];
  }
}
