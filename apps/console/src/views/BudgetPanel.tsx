import { Api } from "../api";
import { usePoll } from "./usePoll";

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The R2 story in the rail: the two governed lanes (ADR-0036), always visible —
 *  monthly dollar spend against the tenant cap (metered loop/Bedrock runs), plus
 *  run-quota consumption (claude-code/subscription runs) when a quota is configured. */
export function BudgetPanel({ api, tenant }: { api: Api; tenant: string }) {
  const { data } = usePoll(() => api.usage(tenant), {
    intervalMs: 30_000,
    onUnauthorized: () => {}, // the views handle the sign-out path; the rail stays quiet
  });
  if (!data) return null;
  const { budget, quota } = data;
  const budgetPct = budget.limitUsd > 0 ? Math.min(100, (budget.spentUsd / budget.limitUsd) * 100) : 0;
  // null limit = quota unbounded (unconfigured) — hide the runs lane rather than clutter.
  const quotaOn = quota.limit != null;
  const quotaPct = quotaOn && quota.limit! > 0 ? Math.min(100, (quota.used / quota.limit!) * 100) : 0;
  return (
    <div className={`budget${budget.ok && quota.ok ? "" : " over"}`}>
      <div className="row">
        <span>Budget · month</span>
        <span className="amount">
          {usd(budget.spentUsd)} / {usd(budget.limitUsd)}
        </span>
      </div>
      <div className="bar">
        <span style={{ width: `${budgetPct}%` }} />
      </div>
      {quotaOn && (
        <>
          <div className="row">
            <span>Runs · month</span>
            <span className="amount">
              {quota.used} / {quota.limit}
            </span>
          </div>
          <div className="bar">
            <span style={{ width: `${quotaPct}%` }} />
          </div>
        </>
      )}
    </div>
  );
}
