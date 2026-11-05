// Weekly review: a trade counts for the week it CLOSED in.
//
// A trade opened last Friday and closed this Tuesday must appear in this
// week's "Closed N trades" and not in last week's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateWeeklyMetrics, type ClosedTrade } from "../calculator.js";

const LAST_WEEK = { startIso: "2026-10-19T00:00:00.000Z", endIso: "2026-10-25T23:59:59.999Z" };
const THIS_WEEK = { startIso: "2026-10-26T00:00:00.000Z", endIso: "2026-11-01T23:59:59.999Z" };

function trade(over: Partial<ClosedTrade>): ClosedTrade {
  return {
    id: 1, symbol: "EURUSD", strategy: "breakout", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    pnl: 10, status: "CLOSED_WIN", closedAtIso: null, createdAtIso: "2026-10-20T10:00:00.000Z", ...over,
  };
}

const spanning = trade({ id: 7, pnl: 50, createdAtIso: "2026-10-23T15:00:00.000Z", closedAtIso: "2026-10-27T09:00:00.000Z" });
const lastWeekOnly = trade({ id: 8, pnl: -10, status: "CLOSED_LOSS", createdAtIso: "2026-10-21T08:00:00.000Z", closedAtIso: "2026-10-21T12:00:00.000Z" });

test("a trade opened last week and closed this week counts for this week only", () => {
  const last = calculateWeeklyMetrics([spanning, lastWeekOnly], [], LAST_WEEK);
  assert.equal(last.totalTrades, 1);
  assert.equal(last.worstTradeId, 8);
  assert.equal(last.netProfitLoss, -10);

  const now = calculateWeeklyMetrics([spanning, lastWeekOnly], [], THIS_WEEK);
  assert.equal(now.totalTrades, 1);
  assert.equal(now.bestTradeId, 7);
  assert.equal(now.netProfitLoss, 50);
});

test("a closed trade with no recorded close time is not attributed to any week", () => {
  const m = calculateWeeklyMetrics([trade({ id: 9, closedAtIso: null })], [], THIS_WEEK);
  assert.equal(m.totalTrades, 0);
});

test("without a window the calculator keeps its previous behaviour", () => {
  assert.equal(calculateWeeklyMetrics([spanning, lastWeekOnly], []).totalTrades, 2);
});
