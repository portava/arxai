// Trading Intelligence (Strategy DNA, Trade History) reads
// getTradeHistorySummary. An import with no closed trade carrying a net P/L
// (open positions only, or rows without netPnl) returned Win Rate 0, Total
// P/L 0, Avg Win 0 and Avg Loss 0, so the page's null checks never fired and
// "0% / $0" read as a measured flat record. With no outcome those values are
// unknown: null. The summary also says the P/L currency is not recorded, that
// sources are uploaded files, and what orders topSymbols.
//
// The database is stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/tradeHistory/__qa__/tradeHistorySummaryTruth.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const database = await import("@workspace/db");
const state: { trades: Array<Record<string, unknown>>; imports: Array<Record<string, unknown>> } = { trades: [], imports: [] };

function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self;
  q.then = (ok: (v: unknown[]) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(rows).then(ok, bad);
  return q;
}
const fakeDb = {
  select: () => ({
    from: (table: Table) => chain(() => {
      const name = getTableName(table);
      if (name === "imported_trades") return state.trades;
      if (name === "trade_history_imports") return state.imports;
      return [];
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { getTradeHistorySummary } = await import("../service.js");

const at = (iso: string) => new Date(iso);
const row = (i: number, extra: Record<string, unknown> = {}) => ({
  id: i, userId: 9, symbol: "EURUSD", openedAt: at(`2026-10-0${i}T10:00:00Z`), closedAt: null, netPnl: null,
  sessionLabel: null, ...extra,
});

test("an import with no closed trade has unknown win rate and P/L, not 0% / 0", async () => {
  state.trades = [row(3), row(2), row(1)];
  state.imports = [{ id: 1, source: "MT5_CSV" }];
  const s = await getTradeHistorySummary(9) as Record<string, unknown>;
  assert.equal(s.hasTrades, true);
  assert.equal(s.count, 3);
  assert.equal(s.closedCount, 0);
  assert.equal(s.withoutOutcomeCount, 3);
  assert.equal(s.winRate, null);
  assert.equal(s.totalNetPnl, null);
  assert.equal(s.avgWin, null);
  assert.equal(s.avgLoss, null);
});

test("with closed trades: averages with no trade to average are null; currency, sources and ordering are named", async () => {
  state.trades = [
    row(3, { closedAt: at("2026-10-03T12:00:00Z"), netPnl: 12.5 }),
    row(2, { closedAt: at("2026-10-02T12:00:00Z"), netPnl: 7.5 }),
    row(1),
  ];
  state.imports = [{ id: 1, source: "MT5_CSV" }, { id: 2, source: "MT5_CSV" }];
  const s = await getTradeHistorySummary(9) as Record<string, unknown>;
  assert.equal(s.closedCount, 2);
  assert.equal(s.withoutOutcomeCount, 1);
  assert.equal(s.winRate, 100);
  assert.equal(s.totalNetPnl, 20);
  assert.equal(s.avgWin, 10);
  assert.equal(s.avgLoss, null, "no losing trade: there is no average loss, not 0");
  assert.equal(s.pnlCurrency, null);
  assert.match(String(s.pnlCurrencyNote), /does not record which currency/);
  assert.equal(s.sourcesKind, "IMPORTED_FILES");
  assert.equal(s.importCount, 2);
  assert.equal(s.topSymbolsOrder, "CLOSED_TRADE_COUNT");
  assert.deepEqual(s.sources, ["MT5_CSV"]);
});

// Round 3 review: opened_at is nullable and Postgres puts NULLs first under
// ORDER BY ... DESC, so one row with no open time made trades[0].openedAt null
// and the page said "Date range not recorded" although every other trade had
// a date. The range is the min / max of the recorded open times.
test("a row with no open time does not blank the date range of the dated rows", async () => {
  state.trades = [row(9, { openedAt: null }), row(3), row(2), row(1)];
  state.imports = [{ id: 1, source: "MT5_CSV" }];
  const s = await getTradeHistorySummary(9) as Record<string, unknown>;
  assert.deepEqual(s.dateFrom, at("2026-10-01T10:00:00Z"));
  assert.deepEqual(s.dateTo, at("2026-10-03T10:00:00Z"), "a NULL-first row made the range 'not recorded'");
  assert.equal(s.withoutOpenTimeCount, 1);
});

test("no row has an open time: the range stays not recorded, and the count says so", async () => {
  state.trades = [row(2, { openedAt: null }), row(1, { openedAt: null })];
  state.imports = [{ id: 1, source: "MT5_CSV" }];
  const s = await getTradeHistorySummary(9) as Record<string, unknown>;
  assert.equal(s.dateFrom, null);
  assert.equal(s.dateTo, null);
  assert.equal(s.withoutOpenTimeCount, 2);
});
