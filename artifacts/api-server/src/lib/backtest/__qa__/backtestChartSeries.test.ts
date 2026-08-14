// Task #763 — pure unit tests for the backtest chart-series builder. No DB, no
// network → safe for the offline `ci` lane. Locks: derived-never-fabricated
// equity (cumulative profitLoss from the run's initialBalance), baseline point,
// drawdown math, honest empty state, and the honest provenance label.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBacktestChartSeries, BACKTEST_SERIES_LABEL,
  type BacktestChartTradeInput,
} from "../backtestChartSeries.js";

function trade(p: Partial<BacktestChartTradeInput> & { profitLoss: number; entryTime: string }): BacktestChartTradeInput {
  return {
    direction: "BUY", exitTime: p.entryTime,
    entryPrice: 1, exitPrice: 1, stopLoss: 0.9, takeProfit: 1.2,
    rewardToRisk: 2, result: p.profitLoss >= 0 ? "WIN" : "LOSS",
    ...p,
  };
}

test("empty trades → baseline-only equity, honest label", () => {
  const s = buildBacktestChartSeries({ initialBalance: 10000, trades: [] });
  assert.equal(s.kind, "BACKTEST");
  assert.equal(s.label, BACKTEST_SERIES_LABEL);
  assert.equal(s.initialBalance, 10000);
  assert.equal(s.finalBalance, 10000);
  assert.equal(s.maxDrawdown, 0);
  // No trades → no markers; equity holds only the starting baseline.
  assert.equal(s.markers.length, 0);
  assert.ok(s.equity.length <= 1);
});

test("equity is cumulative profitLoss from initialBalance (not fabricated)", () => {
  const s = buildBacktestChartSeries({
    initialBalance: 10000,
    trades: [
      trade({ profitLoss: 100, entryTime: "2026-01-01T00:00:00.000Z" }),
      trade({ profitLoss: -50, entryTime: "2026-01-02T00:00:00.000Z" }),
      trade({ profitLoss: 200, entryTime: "2026-01-03T00:00:00.000Z" }),
    ],
  });
  const baseline = s.equity[0]!;
  assert.equal(baseline.tradeId, 0);
  assert.equal(baseline.equity, 10000);
  const last = s.equity[s.equity.length - 1]!;
  assert.equal(last.equity, 10000 + 100 - 50 + 200);
  assert.equal(s.finalBalance, 10250);
  assert.equal(s.markers.length, 3);
});

test("drawdown tracks peak-to-trough on the equity curve", () => {
  const s = buildBacktestChartSeries({
    initialBalance: 1000,
    trades: [
      trade({ profitLoss: 500, entryTime: "2026-01-01T00:00:00.000Z" }), // peak 1500
      trade({ profitLoss: -300, entryTime: "2026-01-02T00:00:00.000Z" }), // trough 1200, dd 300
      trade({ profitLoss: -100, entryTime: "2026-01-03T00:00:00.000Z" }), // 1100, dd 400
    ],
  });
  assert.equal(s.maxDrawdown, 400);
  const trough = s.equity.find((p) => p.tradeId === 3)!;
  assert.equal(trough.drawdown, 400);
  assert.equal(trough.peak, 1500);
});

test("summary splits long vs short and best/worst", () => {
  const s = buildBacktestChartSeries({
    initialBalance: 1000,
    trades: [
      trade({ profitLoss: 100, entryTime: "2026-01-01T00:00:00.000Z", direction: "BUY" }),
      trade({ profitLoss: -40, entryTime: "2026-01-02T00:00:00.000Z", direction: "SELL" }),
    ],
  });
  assert.equal(s.summary.totalTrades, 2);
  assert.equal(s.summary.longTrades, 1);
  assert.equal(s.summary.shortTrades, 1);
  assert.equal(s.summary.bestTradeProfitLoss, 100);
  assert.equal(s.summary.worstTradeProfitLoss, -40);
  assert.equal(s.summary.netProfitLoss, 60);
});
