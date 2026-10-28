// Regression: listScenarios read `limit 50` with no ORDER BY. Once more than
// 50 scenarios existed, the row the Replay Simulator had just created could be
// missing from the list, so the dropdown showed "— pick one —" while Run
// Replay ran that hidden scenario. The list is now newest first.
//
// The database is a stub that records the query chain. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/replaySim/__qa__/listScenariosNewestFirst.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

const dialect = new PgDialect();
const calls: { orderBy: SQL[]; limit: number | null } = { orderBy: [], limit: null };
function chain(): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  q.from = () => q;
  q.orderBy = (...args: SQL[]) => { calls.orderBy.push(...args); return q; };
  q.limit = (n: number) => { calls.limit = n; return q; };
  q.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  return q;
}
mock.module("@workspace/db", { namedExports: { ...database, db: { select: () => chain() } } });

const { listScenarios } = await import("../scenarios.js");

test("the scenario list is ordered newest first before the limit", async () => {
  await listScenarios(50);
  assert.equal(calls.limit, 50);
  assert.equal(calls.orderBy.length, 1, "an ORDER BY is applied");
  const rendered = dialect.sqlToQuery(calls.orderBy[0]!).sql;
  assert.match(rendered, /"created_at" desc/);
});
