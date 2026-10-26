import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, type BacktestSimTrade } from "@workspace/domain/backtest";
import { summarizeMissionTest, hasSufficientSample, type MissionTestMetrics } from "@workspace/domain/profit-mission";
import {
  GENERATED_PRICE_EVIDENCE, CLOSED_DRAFT_EVIDENCE, backtestToMissionMetrics,
  projectMissionTestResult, readMissionMetrics,
} from "../missionTestingEvidence.js";

const strong: MissionTestMetrics = {
  totalTrades: 40, winningTrades: 30, losingTrades: 10, winRate: .75,
  netProfitLoss: 100, maxDrawdownPct: 5, averageRr: 2, expectancyR: .4, profitFactor: 1.8,
};
const row = (metricsJson: unknown) => ({
  id: 1, missionId: 2, kind: "BACKTEST", strategyKey: "trendContinuation", symbol: "EURUSD",
  timeframe: "M15", metricsJson, createdAt: new Date("2026-01-01T00:00:00Z"),
  isVerified: true, label: "Verified historical performance", sampleSize: 999,
});

for (const [kind, evidence] of [["BACKTEST", GENERATED_PRICE_EVIDENCE], ["FORWARD", CLOSED_DRAFT_EVIDENCE]] as const) {
  test(`${evidence.source}: a large profitable sample does not establish validated evidence`, () => {
    const summary = summarizeMissionTest({ kind, strategyKey: "trend", symbol: "EURUSD", timeframe: "M15", metrics: strong, evidence });
    assert.equal(summary.sampleSufficient, true);
    assert.equal(summary.promotionEligible, false);
    assert.match(summary.notes.join(" "), /Excluded from promotion/);
    assert.match(summary.notes.join(" "), /does not establish statistical significance/);
  });
}

test("legacy eligible/verified flags and labels cannot promote a stored result", () => {
  const result = projectMissionTestResult(row({ metrics: strong, promotionEligible: true, headline: "Verified" }));
  assert.equal(result.isVerified, false);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.sampleSize, 40);
  assert.match(result.label, /unverified/);
  assert.doesNotMatch(result.headline, /Verified/);
});

for (const evidence of [
  { version: 1, source: "market_history", validation: "verified" },
  { version: 2, source: "generated_prices", validation: "unverified" },
  CLOSED_DRAFT_EVIDENCE, "generated_prices", null,
]) test(`unsupported/mismatched provenance fails closed: ${JSON.stringify(evidence)}`, () => {
  const result = projectMissionTestResult(row({ metrics: strong, evidence, promotionEligible: true }));
  assert.equal(result.evidence.source, "unknown");
  assert.equal(result.isVerified, false);
  assert.equal(result.promotionEligible, false);
});

test("generated-price notes disclose excluded costs and non-currency units", () => {
  const result = projectMissionTestResult(row({ metrics: strong, evidence: GENERATED_PRICE_EVIDENCE }));
  assert.equal(result.label, "Generated-price simulation");
  assert.match(result.notes.join(" "), /not account currency/);
  assert.match(result.notes.join(" "), /Fees, spread and slippage are excluded/);
});

for (const invalid of [null, {}, { ...strong, totalTrades: 3.1 }, { ...strong, netProfitLoss: NaN },
  { ...strong, expectancyR: Infinity }, { ...strong, winRate: 2 }, { ...strong, winningTrades: 41 },
  { ...strong, maxDrawdownPct: -2 }, { ...strong, profitFactor: -1 }]) {
  test(`invalid stored metrics are quarantined: ${JSON.stringify(invalid)}`, () => {
    assert.equal(readMissionMetrics(invalid), null);
    const result = projectMissionTestResult(row({ metrics: invalid, promotionEligible: true }));
    assert.equal(result.isVerified, false);
    assert.equal(result.sampleSize, 0);
    assert.match(result.notes[0]!, /incomplete or invalid/);
  });
}

test("sample thresholds reject fractional/nonfinite counts and do not claim significance", () => {
  for (const sample of [Infinity, NaN, -1, 40.5]) assert.equal(hasSufficientSample("BACKTEST", sample), false);
});

for (const count of [0, 1, 40, 41, null]) test(`forward R coverage is explicit for ${count} observed values`, () => {
  const result = projectMissionTestResult({ ...row({
    metrics: strong, evidence: CLOSED_DRAFT_EVIDENCE,
    experiment: { version: 1, engine: "closed-draft-aggregate-v1", rObservedCount: count, closedDraftCount: 40 },
  }), kind: "FORWARD" });
  if (count === 1) {
    assert.match(result.headline, /observed-subset expectancy 0.40R \(1\/40 R observations\)/);
    assert.match(result.sampleWarning!, /R metrics are incomplete/);
  } else if (count === 40) {
    assert.match(result.notes.join(" "), /40 of 40 closed trades/);
    assert.equal(result.sampleWarning, null);
  } else {
    assert.match(result.headline, /R metrics unavailable/);
    assert.match(result.sampleWarning!, /R metrics are incomplete/);
  }
  assert.equal(result.promotionEligible, false);
});

test("an end-of-run positive exit earns actual partial R instead of the planned target R", () => {
  const trade: BacktestSimTrade = {
    symbol: "EURUSD", direction: "BUY", entryTime: "2026-01-01", exitTime: "2026-01-02",
    entryPrice: 100, stopLoss: 90, takeProfit: 130, exitPrice: 105, profitLoss: 5, rewardToRisk: 3, result: "WIN",
  };
  const metrics = backtestToMissionMetrics(computeMetrics([trade], 100, [100, 105]), [trade], 100);
  assert.equal(metrics.expectancyR, .5);
  assert.equal(metrics.averageRr, .5);
});

test("a partial loss is its realised loss rather than an invented full stop", () => {
  const trade: BacktestSimTrade = {
    symbol: "EURUSD", direction: "SELL", entryTime: "2026-01-01", exitTime: "2026-01-02",
    entryPrice: 100, stopLoss: 110, takeProfit: 70, exitPrice: 102, profitLoss: -2, rewardToRisk: 3, result: "LOSS",
  };
  const metrics = backtestToMissionMetrics(computeMetrics([trade], 100, [100, 98]), [trade], 100);
  assert.equal(metrics.expectancyR, -.2);
});

test("drawdown uses the peak at each loss, never starting balance or a later higher peak", () => {
  const raw = computeMetrics([], 100, [100, 200, 100, 1000, 700]);
  const metrics = backtestToMissionMetrics(raw, [], 100);
  assert.equal(metrics.maxDrawdownPct, 50);
});
