// Trading Calendar / Ruby Memory aggregates (performanceCC/aggregator.ts).
//
// The real aggregator runs; the database handle is a table-aware stub that
// returns the rows each test sets for a table (and honours .limit()).
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/performanceCC/__qa__/performanceCalendarTruth.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

const database = await import("@workspace/db");

const rows = new Map<unknown, unknown[]>();

function chain(): Record<string, unknown> {
  let table: unknown = null;
  let limit: number | null = null;
  const q: Record<string, unknown> = {};
  q.from = (t: unknown) => { table = t; return q; };
  q.where = () => q; q.orderBy = () => q; q.groupBy = () => q;
  q.limit = (n: number) => { limit = n; return q; };
  q.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
    const all = rows.get(table) ?? [];
    return Promise.resolve(limit == null ? all : all.slice(0, limit)).then(resolve, reject);
  };
  return q;
}
mock.module("@workspace/db", {
  namedExports: { ...database, db: { select: () => chain() } },
});
mock.module("../../learning/scopedMemory.js", {
  namedExports: { listOwnEdges: async () => [], listOwnMistakes: async () => [] },
});

const { computeCalendarMonth, computeDailyStats } = await import("../aggregator.js");

function order(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
    lotSize: 0.01, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, status: "CLOSED_TP",
    openedAt: new Date("2026-05-04T08:00:00Z"), closedAt: new Date("2026-05-04T09:00:00Z"),
    exitPrice: 1.12, profitLoss: 2, strategyId: null, tradePlanId: null, decisionId: null,
    clientRequestKey: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => rows.clear());

test("a day with no closed trades is not graded (no 'F'), past or future", async () => {
  const past = await computeCalendarMonth(7, "2020-02");
  assert.equal(past.days.length, 29);
  for (const d of past.days) {
    assert.equal(d.day_status, "NO_TRADE_DAY");
    assert.equal(d.day_rating, null, `${d.date} has nothing to grade`);
    assert.equal(d.is_future, false);
  }
  assert.equal(past.no_trade_days, 29);

  const future = await computeCalendarMonth(7, "2099-01");
  for (const d of future.days) {
    assert.equal(d.day_rating, null);
    assert.equal(d.is_future, true, `${d.date} has not happened yet`);
  }
  assert.equal(future.no_trade_days, 0, "a day that has not happened is not a no-trade day");
});

test("day stats: no closed trades → day_rating null; a winning day is still graded", async () => {
  const empty = await computeDailyStats(7, "2026-05-04");
  assert.equal(empty.day_rating, null);
  assert.equal(empty.day_status, "NO_TRADE_DAY");

  rows.set(database.paperOrdersTable, [order({})]);
  const won = await computeDailyStats(7, "2026-05-04");
  assert.equal(won.day_rating, "A");
});
