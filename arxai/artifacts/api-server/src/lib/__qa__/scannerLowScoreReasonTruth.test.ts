// Truth regression: the LOW_OPPORTUNITY_SCORE final-read reason.
//
// (a) A row scoring 56 is badged LOW_OPPORTUNITY_SCORE; the timing read then
//     adds +10 and relabels it 66 / WEAK before the final read runs. The
//     reason said "the opportunity score at scan time was below the scanner's
//     minimum of 60" next to a shown score of 66, with nothing linking them.
// (b) With no observed spread (spread 0), the spread rule "passed" with
//     penalty 0 and sat in rulesPassed, so "No risk rule failed" covered a
//     check that was never made.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/__qa__/scannerLowScoreReasonTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { AnalysisCandle } from "../aiBrain.js";
import type { ScannerOpportunity } from "../marketScanner.js";

const real = await import("../../brain/timing/marketTimingBrainService.js");
mock.module("../../brain/timing/marketTimingBrainService.js", {
  namedExports: {
    ...real,
    computeTimingRead: async (req: { symbol: string; timeframe?: string }) => ({
      symbol: req.symbol, timeframe: req.timeframe ?? "M15",
      heatScore: 80, tradeabilityScore: 80, edgeScore: 70, dangerScore: 10,
      timingGrade: "A", entryPermission: "GO",
      heatState: "HOT", bestAction: "ENTER", actionReason: "fixture", pressureBias: "BUY",
      newsOverlay: { phase: "NONE" }, broadFlow: { verdict: "NEUTRAL" },
      session: { sessionName: "London", isKillZoneActive: false },
      trapProbability: 10, roomToMove: 60, dataQuality: { label: "real" },
    }),
  },
});

const { analyzeMarketFromCandles } = await import("../aiBrain.js");
const { computeFinalRead, decorateOpportunitiesWithTimingContext } = await import("../marketScanner.js");

function driftBars(): AnalysisCandle[] {
  return Array.from({ length: 30 }, (_, i) => {
    const c = 1.1 * (1 + 0.001 * (i / 29));
    return { o: c - 0.00002, h: c + 0.0001, l: c - 0.0001, c };
  });
}

function lowScoreRow(extra: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD", timeframe: "M15", recommendedAction: "BUY", confidenceScore: 62,
    statusBadge: "LOW_OPPORTUNITY_SCORE", dataSource: "LIVE_FEED", chartConfirmed: true,
    rulesPassed: ["trend_strength_>=_40"], rulesFailed: [],
    opportunity: { score: 56, label: "REJECT", factors: {} },
    newsContext: { riskLevel: "none", alignsWithScanner: null },
    historicalContext: { available: true, winRate: 55, alignsWithScanner: null },
    ...extra,
  } as unknown as ScannerOpportunity;
}

test("(a) after a +10 timing boost to 66, the reason names both scores and does not leave 66 unexplained", async () => {
  const [boosted] = await decorateOpportunitiesWithTimingContext([lowScoreRow()]);
  assert.equal(boosted!.opportunity.score, 66);
  assert.equal(boosted!.opportunity.label, "WEAK");
  assert.equal(boosted!.opportunity.scoreBeforeTiming, 56);
  assert.equal(boosted!.statusBadge, "LOW_OPPORTUNITY_SCORE", "the boost does not re-open the row");
  const fr = computeFinalRead(boosted!);
  assert.equal(fr.label, "NO_TRADE");
  const reason = fr.reasons.find((r) => /opportunity score/i.test(r)) ?? "";
  assert.match(reason, /\b56\b/, reason);
  assert.match(reason, /\b66\b/, reason);
  assert.match(reason, /timing read/i, reason);
});

test("(a) without a timing boost the reason states the row's own score", () => {
  const fr = computeFinalRead(lowScoreRow());
  const reason = fr.reasons.find((r) => /opportunity score/i.test(r)) ?? "";
  assert.match(reason, /opportunity score 56 is below the scanner's minimum of 60/);
});

test("(b) with no observed spread, the spread rule is unchecked, not passed", () => {
  const candles = driftBars();
  const a = analyzeMarketFromCandles("EURUSD", "M15", candles, { mid: candles.at(-1)!.c, spread: 0 }, "LIVE_FEED");
  assert.ok(!a.rulesPassed.includes("spread_acceptable"), `rulesPassed: ${a.rulesPassed}`);
  assert.ok(!a.rulesFailed.includes("spread_acceptable"));
  assert.deepEqual(a.rulesUnchecked, ["spread_acceptable"]);
  assert.match(a.reasonForTrade, /spread not observed/);
});

test("(b) an observed spread is still checked (pass or fail) as before", () => {
  const candles = driftBars();
  const ok = analyzeMarketFromCandles("EURUSD", "M15", candles, { mid: candles.at(-1)!.c, spread: 0.00001 }, "LIVE_FEED");
  assert.ok(ok.rulesPassed.includes("spread_acceptable"));
  assert.deepEqual(ok.rulesUnchecked, []);
  const wide = analyzeMarketFromCandles("EURUSD", "M15", candles, { mid: candles.at(-1)!.c, spread: 0.0005 }, "LIVE_FEED");
  assert.ok(wide.rulesFailed.includes("spread_acceptable"));
});

test("(b) the low-score reason does not say 'No risk rule failed' over an unchecked spread rule", () => {
  const fr = computeFinalRead(lowScoreRow({ rulesUnchecked: ["spread_acceptable"] }));
  const reason = fr.reasons.find((r) => /opportunity score/i.test(r)) ?? "";
  assert.doesNotMatch(reason, /No risk rule failed/);
  assert.match(reason, /spread was not observed/);
});
