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

const { computeAutopilotSummary, computeCalendarMonth, computeDailyStats, computeDayDetail, computeRangeSummary, computeEquityCurve, computeSymbolStats, computeDecisionQuality } = await import("../aggregator.js");

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
  // The hand-logged page is titled "My Demo Trades" on screen.
  assert.match(String(cal.source_note), /My Demo Trades/);
  assert.doesNotMatch(String(cal.source_note), /My Performance/);
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

// paper_trades_rejected (summed into safety_blocks_today) counts every symbol
// a cycle did not open a trade for, ordinary AI HOLDs included. The summary
// says so instead of leaving the field name to call them safety blocks.
test("safety_blocks_today carries a basis: AI holds, loss limit, sniper skips and refusals, not safety blocks", async () => {
  const s = await computeAutopilotSummary(7) as Record<string, unknown>;
  const basis = String(s.safety_blocks_today_basis);
  assert.match(basis, /did not open/i);
  assert.match(basis, /AI (decided to )?hold/i);
  assert.match(basis, /daily paper loss limit/i);
  assert.match(basis, /sniper/i);
  assert.match(basis, /not a count of safety blocks/i);
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

// The paper venue stores profit_loss 0 for a close it could not size for the
// instrument (no contract size or currency conversion), on every close path:
// a trader's manual V75 close with no broker spec is one. That 0 is a
// placeholder, not a break-even: the close is a win or a loss by its price
// move, and its unknown amount is left out of every money figure (as
// Analytics does).
const unsizedV75Loss = (over: Record<string, unknown> = {}) => order({
  id: 2, symbol: "V75", direction: "BUY", entryPrice: 1000, stopLoss: 980, takeProfit: 1040,
  exitPrice: 990, profitLoss: 0, status: "CLOSED_MANUAL", ...over,
});

test("day stats: an unsized manual V75 loss (stored 0) is a loss, not a break-even, and never the best or worst trade", async () => {
  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 2 }), unsizedV75Loss()]);
  const d = await computeDailyStats(7, "2026-05-04");
  assert.equal(d.wins, 1);
  assert.equal(d.losses, 1, "was 0: the stored 0 read as a break-even");
  assert.equal(d.break_even, 0);
  assert.equal(d.net_pnl, 2, "the unsized amount is not known, so it adds nothing");
  assert.equal(d.best_trade, 2);
  assert.equal(d.worst_trade, 2, "was 0.00: the placeholder ranked as the worst trade");
  assert.equal(d.worst_trade_id, 1);
  assert.equal(d.unsized_trades, 1);
  assert.deepEqual(d.unsized_symbols, ["V75"]);
  assert.match(String(d.pnl_note), /1 of 2 closed trades \(V75\) could not be sized/);
  assert.equal(d.profit_factor, null, "the ratio is not known with an unsized close");
  // +2 sized and a loss of unknown size: the day could be up or down.
  assert.equal(d.day_status, "NOT_SIZED_DAY");
  assert.equal(d.day_rating, null);
});

test("day stats: a day whose only close is an unsized loss is a losing day, with its P&L not measured", async () => {
  rows.set(database.paperOrdersTable, [unsizedV75Loss()]);
  const d = await computeDailyStats(7, "2026-05-04");
  assert.equal(d.day_status, "LOSING_DAY", "was BREAK_EVEN_DAY");
  assert.equal(d.day_rating, "F", "was C (net >= 0)");
  assert.equal(d.best_trade, null);
  assert.equal(d.worst_trade, null);
  assert.match(String(d.pnl_note), /P&L not measured: none of the 1 closed trade \(V75\) could be sized/);

  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 2 }), unsizedV75Loss({ id: 3, exitPrice: 1010, status: "CLOSED_TP" })]);
  const up = await computeDailyStats(7, "2026-05-04");
  assert.equal(up.day_status, "WINNING_DAY", "a sized win and an unsized win: the day is up");
  assert.equal(up.wins, 2);
  assert.equal(up.avg_win, 2, "the average win is over sized wins only");
});

test("day detail: an unsized close has no P&L (null) and says why, not a measured 0.00", async () => {
  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 2 }), unsizedV75Loss()]);
  const detail = await computeDayDetail(7, "2026-05-04");
  const row = detail.trades.find((t) => t.trade_id === 2)!;
  assert.equal(row.pnl, null);
  assert.match(String(row.pnl_note), /could not be sized/);
  assert.match(String(row.pnl_note), /moved against you/);
  assert.equal(detail.trades.find((t) => t.trade_id === 1)!.pnl, 2);
});

test("range summary, symbols, equity curve and decision quality leave unsized closes out of money and count them by price move", async () => {
  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 2, decisionId: 41 }), unsizedV75Loss({ decisionId: 42 })]);
  rows.set(database.tradeDecisionLogsTable, [
    { id: 41, userId: 7, shouldTrade: true, confidence: 70, riskScore: 30, createdAt: new Date() },
    { id: 42, userId: 7, shouldTrade: true, confidence: 70, riskScore: 30, createdAt: new Date() },
  ]);
  const r = await computeRangeSummary(7, "all");
  assert.equal(r.losses, 1);
  assert.equal(r.break_even, 0);
  assert.equal(r.net_pnl, 2);
  assert.equal(r.unsized_trades, 1);
  assert.equal(r.avg_daily_pnl, null, "the day's total is not known");
  assert.equal(r.best_day, null, "a day with an unsized close is not ranked");
  assert.equal(r.best_symbol, "EURUSD");
  assert.equal(r.worst_symbol, "EURUSD", "V75's net is not known, so it is not ranked");
  assert.match(String(r.pnl_note), /could not be sized/);

  const sym = (await computeSymbolStats(7, "all")).find((x) => x.symbol === "V75")!;
  assert.equal(sym.losses, 1);
  assert.equal(sym.unsized_trades, 1);
  assert.equal(sym.best_trade_id, null);
  assert.match(String(sym.pnl_note), /P&L not measured/);

  const eq = await computeEquityCurve(7, "all");
  assert.deepEqual(eq.points.map((p) => p.trade_id), [1], "no 0.00 point for the unsized close");
  assert.equal(eq.unsized_trades, 1);
  assert.match(String(eq.pnl_note), /1 of 2 closed trades \(V75\)/);

  const dq = await computeDecisionQuality(7, "all");
  assert.equal(dq.became_win, 1);
  assert.equal(dq.became_loss, 1, "was 0: the unsized loss was neither a win nor a loss");
});

test("calendar month: an unsized loss day is a losing day, and a mixed day is not counted as break-even or no-trade", async () => {
  rows.set(database.paperOrdersTable, [unsizedV75Loss()]);
  const lost = await computeCalendarMonth(7, "2020-02");
  assert.equal(lost.losing_days, 29, "the stub returns the close for every day");
  assert.equal(lost.break_even_days, 0);
  assert.equal(lost.unsized_trades, 29);
  assert.equal(lost.days[0]!.unsized_trades, 1);
  assert.match(String(lost.pnl_note), /P&L not measured/);

  rows.set(database.paperOrdersTable, [order({ id: 1, profitLoss: 2 }), unsizedV75Loss()]);
  const mixed = await computeCalendarMonth(7, "2020-02");
  assert.equal(mixed.not_sized_days, 29);
  assert.equal(mixed.winning_days, 0);
  assert.equal(mixed.break_even_days, 0);
  assert.equal(mixed.no_trade_days, 0);
});
