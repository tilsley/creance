import { Api } from "../api";
import { usePoll } from "./usePoll";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The R2 story in the rail: monthly spend against the tenant cap, always visible. */
export function BudgetPanel({ api, tenant }: { api: Api; tenant: string }) {
  const { data } = usePoll(() => api.budget(tenant), {
    intervalMs: 30_000,
    onUnauthorized: () => {}, // the views handle the sign-out path; the rail stays quiet
  });
  if (!data) return null;
  const pct = data.limitUsd > 0 ? Math.min(100, (data.spentUsd / data.limitUsd) * 100) : 0;
  return (
    <div className={`budget${data.ok ? "" : " over"}`}>
      <div className="row">
        <span>Budget · month</span>
        <span className="amount">
          {usd(data.spentUsd)} / {usd(data.limitUsd)}
        </span>
      </div>
      <div className="bar">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
