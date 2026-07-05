import { Api, type RunStatus, type RunSummary } from "../api";
import { usePoll } from "./usePoll";

export const StatusChip = ({ status }: { status: RunStatus }) => (
  <span className={`chip ${status}`}>{status === "max_steps" ? "max steps" : status}</span>
);

export const cost = (n?: number) => (n == null ? "—" : `$${n.toFixed(5)}`);

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = (Date.now() - d.getTime()) / 60_000;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString();
};

export function RunsView({ api, onUnauthorized }: { api: Api; onUnauthorized: () => void }) {
  const { data: runs, error } = usePoll(() => api.listRuns(), { intervalMs: 5000, onUnauthorized });

  return (
    <>
      <div className="page-head">
        <h1>Runs</h1>
        <span className="sub">newest first · refreshes every 5s</span>
      </div>
      {error && <p className="error">{error}</p>}
      {runs && runs.length === 0 && (
        <div className="runs">
          <div className="empty">
            No runs yet. <a href="#/new">Start the first one.</a>
          </div>
        </div>
      )}
      {runs && runs.length > 0 && (
        <div className="runs">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Task</th>
                <th style={{ textAlign: "right" }}>Cost</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {[...runs]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((r: RunSummary) => (
                  <tr key={r.id} onClick={() => (window.location.hash = `#/runs/${r.id}`)}>
                    <td className="id">{r.id.slice(0, 8)}</td>
                    <td>
                      <StatusChip status={r.status} />
                    </td>
                    <td>{r.agent ?? "loop"}</td>
                    <td className="task" title={r.task}>
                      {r.task}
                    </td>
                    <td className="cost">{cost(r.costUsd)}</td>
                    <td className="when">{when(r.updatedAt)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
