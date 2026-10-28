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

const { computeAutopilotSummary, computeCalendarMonth, computeDailyStats, computeDayDetail, computeRangeSummary } = await import("../aggregator.js");

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

test("day detail: an OPEN or CANCELLED order has no P&L (null), not a measured 0.00", async () => {
  rows.set(database.paperOrdersTable, [
    order({ id: 12, status: "OPEN", closedAt: null, exitPrice: null, profitLoss: 0 }),
    order({ id: 13, status: "CANCELLED", profitLoss: 0 }),
    order({ id: 14, status: "CLOSED_TP", profitLoss: 2 }),
  ]);
  const detail = await computeDayDetail(7, "2026-05-04");
  const byId = new Map(detail.trades.map((t) => [t.trade_id, t]));
  assert.equal(byId.get(12)!.pnl, null);
  assert.match(String(byId.get(12)!.pnl_note), /open/i);
  assert.equal(byId.get(13)!.pnl, null);
  assert.match(String(byId.get(13)!.pnl_note), /cancelled/i);
  assert.equal(byId.get(14)!.pnl, 2);
  assert.equal(byId.get(14)!.pnl_note, null);
});

test("the Trading Calendar names its ledger (simulated orders) and says hand-logged demo trades are not in it", async () => {
  const cal = await computeCalendarMonth(7, "2020-02") as Record<string, unknown>;
  assert.equal(cal.source, "PAPER_ORDERS");
  assert.match(String(cal.source_note), /simulated orders/i);
  assert.match(String(cal.source_note), /My Performance/);
  assert.match(String(cal.source_note), /not included/i);
});

test("autopilot 'today' counts every cycle started today (UTC), not only the last 50", async () => {
  const now = Date.now();
  rows.set(database.autopilotCyclesTable, Array.from({ length: 120 }, (_, i) => ({
    id: 120 - i, autopilotCycleId: `cyc-${120 - i}`, userId: 7, status: "COMPLETED",
    startedAt: new Date(now - i * 1000), finishedAt: new Date(now - i * 1000 + 500),
    paperTradesOpened: 1, paperTradesRejected: 1, paperTradesClosed: 1,
    debriefsTriggered: 0, learningEventsTriggered: 0,
  })));
  const s = await computeAutopilotSummary(7) as Record<string, unknown>;
  assert.equal(s.cycles_today, 120);
  assert.equal(s.paper_trades_opened_today, 120);
  assert.equal(s.paper_trades_closed_today, 120);
  assert.equal(s.safety_blocks_today, 120);
  assert.equal((s.last_cycle as { autopilot_cycle_id: string }).autopilot_cycle_id, "cyc-120");
  assert.equal(s.today_basis, "UTC");
  assert.equal(s.today_utc, new Date().toISOString().slice(0, 10));
});

test("autopilot with no cycles today: zero counts are labelled as no run today", async () => {
  const s = await computeAutopilotSummary(7) as Record<string, unknown>;
  assert.equal(s.cycles_today, 0);
  assert.equal(s.ran_today, false);
  assert.equal(s.last_cycle, null);
});

test("profit factor with no losing trade is undefined (null), not an invented 9.99", async () => {
  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 2 })]);
  const day = await computeDailyStats(7, "2026-05-04");
  assert.equal(day.profit_factor, null);
  const range = await computeRangeSummary(7, "30d");
  assert.equal(range.profit_factor, null);

  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 3 }), order({ id: 2, profitLoss: -1.5, status: "CLOSED_SL" })]);
  assert.equal((await computeDailyStats(7, "2026-05-04")).profit_factor, 2);
  assert.equal((await computeRangeSummary(7, "30d")).profit_factor, 2);

  rows.clear();
  assert.equal((await computeDailyStats(7, "2026-05-04")).profit_factor, null, "no closed trades: nothing to divide");
});
