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

// Price-unit precision is independent of an arbitrary account-like plot offset.
import { formatBacktestPriceUnits, formatBacktestNumber, formatBacktestPercent, formatBacktestProfitFactor, backtestDiagnosticSummary } from "@workspace/domain/backtest";

test("a small FX loss is never rounded to a flat curve, zero marker or zero drawdown", () => {
  const s = buildBacktestChartSeries({ initialBalance: 10000, trades: [trade({ profitLoss: -0.001, entryTime: "2026-01-01" })] });
  assert.equal(s.summary.netProfitLoss, -0.001); assert.equal(s.maxDrawdown, 0.001);
  assert.equal(s.markers[0]!.profitLoss, -0.001);
  assert.equal(s.equity[1]!.grossPriceUnits, -0.001); assert.equal(s.equity[1]!.peakGrossPriceUnits, 0);
  assert.equal(s.equity[1]!.drawdown, 0.001);
});
test("gross P&L and drawdown survive an offset too large to represent the tiny move", () => {
  const trades = [trade({ profitLoss: .000001, entryTime: "2026-01-01" }), trade({ profitLoss: -.000002, entryTime: "2026-01-02" })];
  const regular = buildBacktestChartSeries({ initialBalance: 10000, trades });
  const large = buildBacktestChartSeries({ initialBalance: 1e20, trades });
  assert.equal(large.equity[2]!.equity, 1e20); // compatibility field lacks precision
  assert.equal(large.equity[2]!.grossPriceUnits, -.000001);
  assert.equal(large.equity[2]!.peakGrossPriceUnits, .000001);
  assert.equal(large.maxDrawdown, .000002); assert.equal(large.maxDrawdown, regular.maxDrawdown);
  assert.equal(large.summary.netProfitLoss, regular.summary.netProfitLoss);
});
for (const invalid of [NaN, Infinity, -Infinity, null]) test(`malformed P&L ${String(invalid)} rejects the series instead of manufacturing zero`, () => {
  assert.throws(() => buildBacktestChartSeries({ initialBalance: 10000, trades: [trade({ profitLoss: invalid as number, entryTime: "2026-01-01" })] }), /profitLoss is unavailable/);
});
test("invalid plotting offset and cumulative overflow reject explicitly", () => {
  assert.throws(() => buildBacktestChartSeries({ initialBalance: NaN, trades: [] }), /plotting offset is unavailable/);
  assert.throws(() => buildBacktestChartSeries({ initialBalance: 0, trades: [trade({ profitLoss: 1e308, entryTime: "2026-01-01" }), trade({ profitLoss: 1e308, entryTime: "2026-01-02" })] }), /cumulative P\/L is unavailable/);
});
for (const invalid of [null, undefined, NaN, Infinity, -Infinity, "0"]) test(`display helpers keep ${String(invalid)} unavailable`, () => {
  for (const format of [formatBacktestPriceUnits, formatBacktestNumber, formatBacktestPercent, formatBacktestProfitFactor]) assert.equal(format(invalid), "Unavailable");
});
test("adaptive price units preserve small signs and significant precision", () => {
  assert.equal(formatBacktestPriceUnits(-.001), "-0.001");
  assert.equal(formatBacktestPriceUnits(.00001), "0.00001");
  assert.equal(formatBacktestPriceUnits(-1e-12), "-1e-12");
  assert.equal(formatBacktestPriceUnits(0), "0"); assert.equal(formatBacktestPriceUnits(-0), "0");
  assert.equal(formatBacktestPriceUnits(Number.MIN_VALUE), "4.940656458e-324");
});
test("legacy profit-factor marker is ambiguous while higher finite ratios remain numeric", () => {
  assert.equal(formatBacktestProfitFactor(999), "Unavailable (legacy 999 marker)");
  assert.equal(formatBacktestProfitFactor(1000), "1,000"); assert.equal(formatBacktestProfitFactor(0), "0");
  assert.equal(formatBacktestPercent(.125), "12.5%"); assert.equal(formatBacktestPercent(Number.MAX_VALUE), "Unavailable");
});
test("tiny finite ratios do not become zero and negative zero has no misleading sign", () => {
  assert.equal(formatBacktestNumber(.000001), "0.000001");
  assert.equal(formatBacktestProfitFactor(.000001), "0.000001");
  assert.equal(formatBacktestPercent(.000001), "0.0001%");
  assert.equal(formatBacktestNumber(-0), "0");
  assert.equal(formatBacktestPercent(-0), "0%");
});
test("diagnostic summary preserves the FX loss and does not relabel finite high PF as infinity", () => {
  const text = backtestDiagnosticSummary({ strategyId: "trend", symbol: "EURUSD", timeframe: "M15", totalTrades: 10, winRate: .5, profitFactor: 1000, netProfitLoss: -.001, dataSource: "broker" });
  assert.match(text, /gross P&L -0.001 price units/); assert.match(text, /profit factor 1,000/);
  assert.doesNotMatch(text, /Infinity|not finite|legacy capped/); assert.match(text, /Diagnostic only/);
});
