// Performance-calendar NULL-P/L honesty.
//
// A closed trade whose realised P/L was never recorded (pnl IS NULL) used to
// be minted as a $0 "breakeven" trade — folded into totalPnl, winRate, and
// even bestTrade/worstTrade — on both the paper branch and the live
// shared_trade_attribution branch, with no exclusion marker. That contradicts
// /performance/summary, which excludes untrusted rows and reports the count.
// aggregate() now mirrors that contract; this suite locks it:
//
//   * NULL-pnl rows contribute to NO money aggregate (totalPnl, winRate,
//     wins/losses/breakeven, bestTrade/worstTrade, totalRisk)
//   * they ARE disclosed via excludedUnknownPnl on the day
//   * a day whose every trade is excluded still exists (activity happened)
//     but claims no money figures — bestTrade/worstTrade stay null
//   * a genuine $0 close is still an honest breakeven
//
// Run: node --import tsx --test src/routes/__qa__/mePerformanceCalendarNullPnl.test.ts

// The route module reaches @workspace/db at import time; the placeholder keeps
// the lane offline (nothing here opens a connection).
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";

const { aggregate } = await import("../mePerformanceCalendar.js");

type Row = Parameters<typeof aggregate>[0][number];
function row(over: Partial<Row>): Row {
  return {
    id: 1,
    symbol: "EURUSD",
    side: "BUY",
    pnl: 0,
    lotSize: 0.01,
    entryPrice: 1.1,
    exitPrice: 1.1,
    strategyTag: null,
    riskAmount: null,
    closedAt: new Date("2026-08-30T08:00:00.000Z"),
    ...over,
  };
}

test("a NULL-pnl close is excluded from every money figure AND counted", () => {
  const days = aggregate([
    row({ pnl: -50 }),
    row({ pnl: null, riskAmount: 25 }),
  ]);
  const d = days["2026-08-30"]!;
  assert.equal(d.tradesCount, 1);
  assert.equal(d.totalPnl, -50);
  assert.equal(d.wins, 0);
  assert.equal(d.losses, 1);
  assert.equal(d.breakeven, 0, "an unknown P/L must not be minted as a $0 breakeven");
  assert.equal(d.bestTrade, -50, "the excluded row's phantom 0 must not become bestTrade");
  assert.equal(d.worstTrade, -50);
  assert.equal(d.winRate, 0);
  assert.equal(d.totalRisk, 0, "excluded rows contribute to no aggregate at all");
  assert.equal(d.excludedUnknownPnl, 1);
});

test("winRate is computed over trusted trades only", () => {
  const days = aggregate([
    row({ pnl: 10 }),
    row({ pnl: -10 }),
    row({ pnl: null }),
    row({ pnl: null }),
  ]);
  const d = days["2026-08-30"]!;
  assert.equal(d.tradesCount, 2);
  assert.equal(d.winRate, 50, "the shipped bug diluted winRate with phantom breakevens (25%)");
  assert.equal(d.excludedUnknownPnl, 2);
});

test("a day of ONLY unknown-P/L closes exists but claims no money", () => {
  const days = aggregate([row({ pnl: null }), row({ pnl: null })]);
  const d = days["2026-08-30"]!;
  assert.ok(d, "the day had real activity — it must not vanish");
  assert.equal(d.tradesCount, 0);
  assert.equal(d.totalPnl, 0);
  assert.equal(d.bestTrade, null, "no trusted trade → no best trade, not $0");
  assert.equal(d.worstTrade, null);
  assert.equal(d.excludedUnknownPnl, 2);
});

test("a genuine $0 close is still an honest breakeven", () => {
  const days = aggregate([row({ pnl: 0 })]);
  const d = days["2026-08-30"]!;
  assert.equal(d.tradesCount, 1);
  assert.equal(d.breakeven, 1);
  assert.equal(d.bestTrade, 0);
  assert.equal(d.excludedUnknownPnl, 0);
});

test("exclusions bucket per day, not across the range", () => {
  const days = aggregate([
    row({ pnl: null }),
    row({ pnl: 5, closedAt: new Date("2026-08-29T08:00:00.000Z") }),
  ]);
  assert.equal(days["2026-08-30"]!.excludedUnknownPnl, 1);
  assert.equal(days["2026-08-29"]!.excludedUnknownPnl, 0);
  assert.equal(days["2026-08-29"]!.totalPnl, 5);
});
