/**
 * PostgresSpendStore — live semantics against a real Postgres (the same checks the
 * Python store validated: reserve / deny-on-breach-atomic / settle / scope keys).
 * Needs a database, so it's GATED: runs only when SPEND_DATABASE_URL is set, e.g.
 *   docker run -d --name agentos-pg -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16-alpine
 *   SPEND_DATABASE_URL='postgresql://postgres:test@localhost:5432/postgres' bun test postgres-spend-store
 */
import { test, expect } from "bun:test";
import { PostgresSpendStore } from "./postgres-spend-store";

const url = process.env.SPEND_DATABASE_URL;
const live = test.if(Boolean(url));
const T = `t-${process.pid}-${Date.now()}`; // unique tenant per run — no cross-run state
const P = "2026-06";

const store = url ? new PostgresSpendStore(url) : undefined;

live("reserve under the cap → new total; get() sees it", async () => {
  expect(await store!.reserve(T, P, 0.4, 1.0)).toBe(0.4);
  expect(await store!.get(T, P)).toBe(0.4);
});

live("deny-on-breach is atomic — nothing written", async () => {
  expect(await store!.reserve(T, P, 0.7, 1.0)).toBeNull(); // 0.4 + 0.7 > 1.0
  expect(await store!.get(T, P)).toBe(0.4); // unchanged
});

live("settle reconciles the reservation to actual (negative delta)", async () => {
  expect(await store!.add(T, P, -0.3)).toBeCloseTo(0.1, 10);
});

live("concurrent reservations can't both slip past the cap", async () => {
  const t = `${T}-race`;
  // five concurrent 0.4 reserves under a 1.0 cap: exactly two can fit
  const results = await Promise.all(Array.from({ length: 5 }, () => store!.reserve(t, P, 0.4, 1.0)));
  expect(results.filter((r) => r !== null).length).toBe(2);
  expect(await store!.get(t, P)).toBeCloseTo(0.8, 10);
});

live("scopes are independent keys (session vs month — the multi-scope cap)", async () => {
  const session = `session#s1-${T}`;
  expect(await store!.reserve(session, P, 0.2, 0.25)).toBe(0.2);
  expect(await store!.get(T, P)).toBeCloseTo(0.1, 10); // tenant scope untouched
});
