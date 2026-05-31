/**
 * The claims-controller's decision, as a pure function (ADR-0021 / slice 7) — unit-testable
 * without a cluster. A ValidatingAdmissionPolicy already checked each claim against its
 * namespace's allowance per-object at apply; this is the cross-object part it can't do: the
 * SUM of a namespace's claims must stay within the allowance. Claims are taken in creation
 * order; each fits until the running total tips over, after which it (and later claims) are
 * rejected — so an admin sees exactly which claims overflow the budget.
 */
export interface ClaimLite {
  name: string;
  monthlyBudgetUsd: number;
  creationTimestamp?: string;
}

export interface Verdict {
  ready: boolean;
  reason: string;
  message: string;
}

export function evaluate(claims: ClaimLite[], maxMonthlyUsd: number | undefined): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  if (maxMonthlyUsd == null) {
    // defensive — the VAP's parameterNotFoundAction=Deny already blocks claims without an allowance
    for (const c of claims) out.set(c.name, { ready: false, reason: "NoAllowance", message: "no InferenceAllowance in namespace" });
    return out;
  }
  const sorted = [...claims].sort((a, b) => (a.creationTimestamp ?? "").localeCompare(b.creationTimestamp ?? ""));
  let sum = 0;
  for (const c of sorted) {
    sum += c.monthlyBudgetUsd;
    out.set(
      c.name,
      sum <= maxMonthlyUsd
        ? { ready: true, reason: "WithinAllowance", message: `within namespace allowance ($${sum} of $${maxMonthlyUsd})` }
        : { ready: false, reason: "AllowanceExceeded", message: `namespace claims total $${sum} exceeds allowance $${maxMonthlyUsd}` },
    );
  }
  return out;
}
