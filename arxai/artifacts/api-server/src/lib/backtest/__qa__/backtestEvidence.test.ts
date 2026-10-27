import { test } from "node:test";
import assert from "node:assert/strict";
import { backtestEvidence, backtestSourceLabel, projectBacktestRun, isVerificationEligible, summarizeBacktest, computeMetrics } from "@workspace/domain/backtest";

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
