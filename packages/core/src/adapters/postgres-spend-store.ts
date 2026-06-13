/**
 * PostgresSpendStore — the durable, ACID home for the budget (ADR-0023/0026), ported from
 * the LiteLLM hook's PostgresSpendStore (admission_hook.py) per ADR-0028. The reserve is
 * ONE conditional upsert: insert-or-add iff the new total stays <= ceiling, RETURNING the
 * new total; no row returned = would breach (nothing written). Check and add are a single
 * statement, so concurrent reservations can't both slip past the cap.
 *
 * Same table as the Python store (`budgets(tenant, period, spent_usd)`), so a deployment
 * can swap engines without migrating money. Targets Aurora Serverless v2 (scale-to-zero)
 * in prod; any Postgres (local container) in dev. Uses Bun's built-in SQL client — no
 * driver dependency.
 *
 * Env: SPEND_STORE=postgres + SPEND_DATABASE_URL (deliberately NOT `DATABASE_URL` — the
 * name is kept from the Python store so deployments swap engines by env alone).
 * Keyless Aurora IAM auth (SPEND_DB_IAM, a fresh 15-min RDS token per connection) is a
 * documented follow-up: Bun's pool has no per-connection password hook yet; the validated
 * recipe lives in the Python reference + deploy/aurora/iam-bootstrap.sql.
 */
import { SQL } from "bun";
import type { SpendStore } from "../gate";

export class PostgresSpendStore implements SpendStore {
  readonly name = "postgres";
  private readonly sql: SQL;
  private ready?: Promise<unknown>;

  constructor(url: string, maxConnections = 5) {
    this.sql = new SQL({ url, max: maxConnections });
  }

  /** Lazy one-time schema init (the constructor can't await). */
  private ensure(): Promise<unknown> {
    return (this.ready ??= this.sql`
      CREATE TABLE IF NOT EXISTS budgets (
        tenant    TEXT    NOT NULL,
        period    TEXT    NOT NULL,
        spent_usd NUMERIC NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, period))`);
  }

  async get(tenant: string, period: string): Promise<number> {
    await this.ensure();
    const rows = await this.sql`SELECT spent_usd FROM budgets WHERE tenant = ${tenant} AND period = ${period}`;
    return rows[0] ? Number(rows[0].spent_usd) : 0; // NUMERIC arrives as a string
  }

  /** Unconditional atomic add — settle (reconcile to actual) and refund. */
  async add(tenant: string, period: string, usd: number): Promise<number> {
    await this.ensure();
    const rows = await this.sql`
      INSERT INTO budgets (tenant, period, spent_usd) VALUES (${tenant}, ${period}, ${usd})
      ON CONFLICT (tenant, period) DO UPDATE
        SET spent_usd = budgets.spent_usd + EXCLUDED.spent_usd
      RETURNING spent_usd`;
    return Number(rows[0].spent_usd);
  }

  /** Add `delta` iff the result stays <= ceiling — one atomic statement (the conditional
   *  UPDATE *is* the reserve). Returns the new total, or null if it would breach (nothing
   *  written). Callers pre-check delta <= ceiling so the first-write (INSERT) case is safe. */
  async reserve(tenant: string, period: string, delta: number, ceiling: number): Promise<number | null> {
    await this.ensure();
    const rows = await this.sql`
      INSERT INTO budgets (tenant, period, spent_usd) VALUES (${tenant}, ${period}, ${delta})
      ON CONFLICT (tenant, period) DO UPDATE
        SET spent_usd = budgets.spent_usd + EXCLUDED.spent_usd
        WHERE budgets.spent_usd + EXCLUDED.spent_usd <= ${ceiling}
      RETURNING spent_usd`;
    return rows[0] ? Number(rows[0].spent_usd) : null;
  }

  /** Close the pool (tests / graceful shutdown). */
  async close(): Promise<void> {
    await this.sql.end();
  }
}
