import { useEffect, useState } from "react";
import { Api, ApiError, type AgentSpec, type DispatchMode } from "../api";

/** Human names for the substrates behind the dispatch seam (ADR-0031/0042). */
const DISPATCH_LABELS: Record<DispatchMode, string> = {
  inprocess: "In-process (dev)",
  runtask: "Fargate task",
  agentcore: "AgentCore microVM",
  agentengine: "Vertex Agent Runtime (GCP)",
};

export function NewRunView({ api, onUnauthorized }: { api: Api; onUnauthorized: () => void }) {
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [agent, setAgent] = useState<string>("");
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("");
  const [dispatch, setDispatch] = useState<{ default: DispatchMode; modes: DispatchMode[] } | null>(null);
  const [substrate, setSubstrate] = useState<DispatchMode | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // repo targeting applies to coding runs (ADR-0034): the agent is repo-agnostic,
  // the run names the repo, the gate authorizes it.
  const isCodingAgent = agents.find((a) => a.name === agent)?.kind === "claude-code";

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
      });
    // which substrates the deployment offers — hide the selector when there's no choice
    api
      .info()
      .then((i) => setDispatch(i.dispatch ?? null))
      .catch(() => setDispatch(null));
  }, [api, onUnauthorized]);

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createRun(
        task.trim(),
        agent || undefined,
        (isCodingAgent && repo.trim()) || undefined,
        (!isCodingAgent && substrate) || undefined,
      );
      window.location.hash = `#/runs/${r.runId}`;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      if (e instanceof ApiError && e.status === 402) setError("Budget exceeded — the gate refused this run.");
      else setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>New run</h1>
      </div>
      <div className="form">
        <label>
          Task
          <textarea
            rows={5}
            value={task}
            placeholder="What should the agent do?"
            onChange={(e) => setTask(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          Agent
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">default loop</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.kind && a.kind !== "loop" ? ` (${a.kind})` : ""}
              </option>
            ))}
          </select>
        </label>
        {dispatch && dispatch.modes.length > 1 && !isCodingAgent && (
          <label>
            Substrate{" "}
            <span className="hint">(where the run executes — claude-code agents always ride Fargate)</span>
            <select value={substrate} onChange={(e) => setSubstrate(e.target.value as DispatchMode | "")}>
              <option value="">{DISPATCH_LABELS[dispatch.default] ?? dispatch.default} (default)</option>
              {dispatch.modes
                .filter((m) => m !== dispatch.default)
                .map((m) => (
                  <option key={m} value={m}>
                    {DISPATCH_LABELS[m] ?? m}
                  </option>
                ))}
            </select>
          </label>
        )}
        {isCodingAgent && (
          <label>
            Repo <span className="hint">(optional — owner/name; the run clones it and pushes a run/&lt;id&gt; branch + PR)</span>
            <input
              type="text"
              value={repo}
              placeholder="tilsley/chart-val"
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button className="button" disabled={busy || !task.trim()} onClick={launch}>
            {busy ? "Launching…" : "Launch run"}
          </button>
          <span className="hint">Admission is gated: identity, then budget, then dispatch.</span>
        </div>
      </div>
    </>
  );
}
