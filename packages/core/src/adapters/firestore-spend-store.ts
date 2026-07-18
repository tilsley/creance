/**
 * FirestoreSpendStore — the durable, monthly-windowed `SpendStore` for the GCP managed
 * profile (ADR-0044 phase 4b), the Firestore twin of DynamoSpendStore. It exists for the
 * same reason FirestoreRunStore does: DISPATCH=agentengine splits a run across two
 * processes, so per-tenant *spend* must live in ONE ledger both see — the front door's
 * coarse `checkBudget` admission and the engine's per-token `reserve`/`settle` accounting
 * (via the AdmissionInferenceProvider) have to hit the same counter, or a budget that
 * looks enforced in one process is invisible in the other.
 *
 * Dependency-free Firestore REST v1 + an ADC token (same stance as the run store — no
 * google-cloud SDK in the shared image). Each (tenant, period) is one document holding a
 * single `spentUsd` number; period is "YYYY-MM" for the monthly dollar cap and the
 * namespaced forms LocalGate passes for the session cap (`session#<id>`) and run quota
 * (`runs#<period>`) — this store is agnostic to the semantics, it just counts.
 *
 * The hard part is `reserve`: an ATOMIC conditional add (add iff the result stays within
 * `ceiling`) that holds across PROCESSES, not just within one. DynamoDB gets this from a
 * single conditional UpdateItem; Firestore field transforms can't express the ceiling, so
 * we use **optimistic concurrency** — read the doc's `updateTime`, then PATCH with a
 * `currentDocument` precondition (updateTime match, or exists=false for the first write).
 * A concurrent writer bumps updateTime, the precondition fails (409/FAILED_PRECONDITION),
 * and we retry on the fresh value. This is the multi-writer-correct version of the run
 * store's single-process FIFO serialization.
 */
import type { SpendStore } from "../gate";
import { gcpAccessToken } from "./gcp-auth";

/** How many optimistic-CAS attempts before giving up under sustained contention. */
const MAX_CAS_ATTEMPTS = 8;

interface FsSpendDoc {
  fields?: { spentUsd?: { doubleValue?: number; integerValue?: string } };
  updateTime?: string;
}

export class FirestoreSpendStore implements SpendStore {
  readonly name = "firestore";
  private readonly base: string;
  private readonly collection: string;

  constructor(
    project: string,
    opts: { database?: string; collection?: string; endpoint?: string } = {},
  ) {
    const database = opts.database ?? "(default)";
    const host = opts.endpoint ?? "https://firestore.googleapis.com";
    this.base = `${host}/v1/projects/${project}/databases/${database}/documents`;
    this.collection = opts.collection ?? "budgets";
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await gcpAccessToken()}`, "content-type": "application/json" };
  }

  /** One document per (tenant, period). `#` separators are valid in Firestore ids; guard
   *  only against `/` (the one illegal char) so namespaced periods stay one path segment. */
  private docId(tenant: string, period: string): string {
    return `${tenant}#${period}`.replace(/\//g, "_");
  }

  private docUrl(tenant: string, period: string): string {
    return `${this.base}/${this.collection}/${encodeURIComponent(this.docId(tenant, period))}`;
  }

  private parseTotal(doc: FsSpendDoc): number {
    const f = doc.fields?.spentUsd;
    if (!f) return 0;
    return Number(f.doubleValue ?? f.integerValue ?? 0);
  }

  /** Read the current total + the doc's updateTime (for the CAS precondition). Missing
   *  doc ⇒ total 0, exists=false. */
  private async read(tenant: string, period: string): Promise<{ total: number; updateTime?: string; exists: boolean }> {
    const res = await fetch(this.docUrl(tenant, period), { headers: await this.authHeaders() });
    if (res.status === 404) return { total: 0, exists: false };
    if (!res.ok) throw new Error(`Firestore spend read ${this.docId(tenant, period)} failed ${res.status}: ${await res.text()}`);
    const doc = (await res.json()) as FsSpendDoc;
    return { total: this.parseTotal(doc), updateTime: doc.updateTime, exists: true };
  }

  async get(tenant: string, period: string): Promise<number> {
    return (await this.read(tenant, period)).total;
  }

  /**
   * Optimistic conditional add: read → (optional ceiling check) → PATCH guarded by a
   * `currentDocument` precondition, retrying when a concurrent writer invalidates it.
   * `ceiling === undefined` ⇒ unconditional (the `add` path). Returns the new total, or
   * `null` when the ceiling would be breached (never writes in that case).
   */
  private async casAdd(tenant: string, period: string, delta: number, ceiling?: number): Promise<number | null> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const { total, updateTime, exists } = await this.read(tenant, period);
      const next = total + delta;
      if (ceiling !== undefined && next > ceiling) return null; // would breach — no write
      // Precondition: an existing doc must be UNCHANGED since our read (updateTime match);
      // a missing doc must still be absent (exists=false). Either failing ⇒ someone raced us.
      const precond = exists
        ? `currentDocument.updateTime=${encodeURIComponent(updateTime!)}`
        : `currentDocument.exists=false`;
      const url = `${this.docUrl(tenant, period)}?updateMask.fieldPaths=spentUsd&${precond}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: await this.authHeaders(),
        body: JSON.stringify({ fields: { spentUsd: { doubleValue: next } } }),
      });
      if (res.ok) return next;
      // 409 (ABORTED) or 400 FAILED_PRECONDITION ⇒ lost the race; re-read and retry.
      const body = res.status === 409 || res.status === 400 ? await res.text() : "";
      if (res.status === 409 || (res.status === 400 && /FAILED_PRECONDITION|precondition/i.test(body))) continue;
      throw new Error(`Firestore spend write ${this.docId(tenant, period)} failed ${res.status}: ${body || (await res.text())}`);
    }
    throw new Error(`Firestore spend reserve for ${this.docId(tenant, period)} exhausted ${MAX_CAS_ATTEMPTS} attempts under contention`);
  }

  async add(tenant: string, period: string, usd: number): Promise<number> {
    return (await this.casAdd(tenant, period, usd)) as number; // no ceiling ⇒ never null
  }

  async reserve(tenant: string, period: string, delta: number, ceiling: number): Promise<number | null> {
    return this.casAdd(tenant, period, delta, ceiling);
  }
}
