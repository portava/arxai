import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestEvidence, backtestSourceLabel, projectBacktestRun, isVerificationEligible, summarizeBacktest, computeMetrics } from "@workspace/domain/backtest";
import type { BacktestSimTrade } from "@workspace/domain/backtest";
import { buildBacktestChartSeries } from "../backtestChartSeries.js";

function ledgerTrade(profitLoss: number, index: number): BacktestSimTrade {
  return { symbol: "EURUSD", direction: "BUY", entryTime: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    exitTime: `2026-01-${String(index + 1).padStart(2, "0")}T00:01:00Z`,
    entryPrice: 1.1, exitPrice: 1.1 + profitLoss, stopLoss: 1, takeProfit: 1.2, rewardToRisk: 1,
    profitLoss, result: profitLoss > 0 ? "WIN" : profitLoss < 0 ? "LOSS" : "TIMEOUT" };
}

test("expectancy includes flat completed outcomes without counting them as losses", () => {
  const trades = [.03, -.01, 0, 0].map(ledgerTrade);
  trades[3]!.result = "BREAKEVEN";
  const metrics = computeMetrics(trades, 10000, [10000, 10000.03, 10000.02, 10000.02, 10000.02]);
  assert.equal(metrics.winningTrades, 1);
  assert.equal(metrics.losingTrades, 1);
  assert.equal(metrics.winRate, .25);
  assert.ok(Math.abs(metrics.expectancy - .005) < 1e-15);
  assert.equal(metrics.expectancy, metrics.netProfitLoss / metrics.totalTrades);
});

test("metric drawdown agrees with the chart ledger even when a plotting offset erases FX moves", () => {
  const trades = [.000001, -.000002, 0].map(ledgerTrade);
  for (const initialBalance of [1e20, 10000, 0]) {
    let value = initialBalance;
    const curve = [initialBalance, ...trades.map(t => value += t.profitLoss)];
    const metrics = computeMetrics(trades, initialBalance, curve);
    const chart = buildBacktestChartSeries({ initialBalance, trades });
    assert.equal(metrics.maxDrawdown, .000002);
    assert.equal(metrics.maxDrawdown, chart.maxDrawdown);
    assert.equal(metrics.netProfitLoss, chart.summary.netProfitLoss);
    assert.deepEqual(metrics.equityCurve, curve); // compatibility curve is not rewritten
  }
});

test("ledger summary stays consistent for empty, flat, all-win and recovered-loss sequences", () => {
  for (const pnl of [[], [0, 0], [.01, .02], [-.01, -.02, .05, -.01], [.03, 0, -.02, 0, -.01]]) {
    const trades = pnl.map(ledgerTrade);
    let value = 10000;
    const curve = [value, ...pnl.map(p => value += p)];
    const metrics = computeMetrics(trades, 10000, curve);
    const chart = buildBacktestChartSeries({ initialBalance: 10000, trades });
    assert.equal(metrics.expectancy, trades.length ? metrics.netProfitLoss / trades.length : 0);
    assert.equal(metrics.maxDrawdown, chart.maxDrawdown);
    assert.equal(metrics.netProfitLoss, chart.summary.netProfitLoss);
  }
});

const strong = { strategyId: "trendContinuation", symbol: "EURUSD", timeframe: "M15", totalTrades: 1000, winRate: .9, profitFactor: 20, netProfitLoss: 10000 };
for (const source of ["synthetic", "broker", undefined, "future_unregistered_source"]) {
  test(`${source}: profitable sample and forged evidence cannot become verification`, () => {
    const row = { ...strong, dataSource: source, isVerified: "VERIFIED", aiSummary: "Guaranteed future success", evidence: { verification: "verified", comparisonEligible: true } };
    const out = projectBacktestRun(row);
    assert.equal(out.isVerified, "UNVERIFIED");
    assert.equal(out.evidence.comparisonEligible, false);
    assert.equal(out.evidence.verification, "unverified");
    assert.match(out.aiSummary, /Diagnostic only/);
    assert.doesNotMatch(out.aiSummary, /Guaranteed|Verification-eligible/);
    assert.equal(row.isVerified, "VERIFIED");
    assert.equal(out.netProfitLoss, row.netProfitLoss);
  });
}
test("trade count/profit factor has no verification authority", () => {
  for (const m of [strong, { totalTrades: 0, profitFactor: 0 }, { totalTrades: Infinity, profitFactor: Infinity }]) assert.equal(isVerificationEligible(m), false);
});
test("unknown input is never relabelled as generated prices", () => {
  assert.equal(backtestEvidence(null).source, "unknown");
  assert.equal(backtestSourceLabel(undefined), "Source unknown");
});
test("broker storage label is not historical account proof", () => {
  const evidence = backtestEvidence("broker");
  assert.equal(evidence.source, "unattested_broker_history");
  assert.match(evidence.limitations.join(" "), /identity were not preserved/);
});
test("summary names missing costs, holdout and unscaled units", () => {
  const metrics = { ...computeMetrics([], 10000, [10000]), ...strong };
  const text = summarizeBacktest({ ...strong, metrics });
  assert.match(text, /price units/);
  assert.match(text, /fees, spreads, slippage and liquidity are not modelled/);
  assert.match(text, /chronological holdout/);
  assert.doesNotMatch(text, /Verification-eligible/);
});
test("missing metrics are unavailable, not formatted as NaN or Infinity", () => {
  const out = projectBacktestRun({ ...strong, netProfitLoss: NaN });
  assert.match(out.aiSummary, /metrics are unavailable/);
  assert.doesNotMatch(out.aiSummary, /NaN|Infinity/);
});
test("empty insufficient run never suggests profitable testing occurred", () => {
  const out = projectBacktestRun({ ...strong, totalTrades: 0, status: "INSUFFICIENT_DATA" });
  assert.match(out.aiSummary, /no completed simulated trades/);
  assert.doesNotMatch(out.aiSummary, /10000.00/);
});
