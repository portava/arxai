// A scanner row that passed every rule must not be badged "Risk too high".
//
// The opportunity score scale tops out near 66 for an ordinary passing BUY, so
// a row with risk 21 and no failed rule can score below 60 and land in the
// REJECT band. That band is a low SCORE, not a risk rejection: the status badge
// must not be REJECTED_BY_RISK ("Risk too high"), the final read must not say
// "setup rejected by risk rules", and no RISK alert may describe it as such.
//
// Run: node --import tsx --test --test-force-exit src/lib/__qa__/scannerStatusBadgeTruth.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMarketFromCandles, type AnalysisCandle } from "../aiBrain.js";
import {
  opportunityScore,
  statusBadgeFor,
  computeFinalRead,
  type ScannerOpportunity,
} from "../marketScanner.js";

/** 30 constructed bars with a steady ~0.1 % drift and even ranges (not market data). */
function driftBars(): AnalysisCandle[] {
  return Array.from({ length: 30 }, (_, i) => {
    const c = 1.1 * (1 + 0.001 * (i / 29));
    return { o: c - 0.00002, h: c + 0.0001, l: c - 0.0001, c };
  });
}

function passingBuy() {
  const candles = driftBars();
  const a = analyzeMarketFromCandles("EURUSD", "M5", candles, { mid: candles.at(-1)!.c, spread: 0.00001 }, "LIVE_FEED");
  const opp = opportunityScore(a, 7, { spreadPrice: 0.00001 });
  return { a, opp };
}

test("fixture: a passing BUY (no failed rule, low risk) scores in the REJECT band", () => {
  const { a, opp } = passingBuy();
  assert.equal(a.recommendedAction, "BUY");
  assert.deepEqual(a.rulesFailed, []);
  assert.ok(a.riskScore < 65, `riskScore ${a.riskScore}`);
  assert.ok(opp.score < 60, `score ${opp.score}`);
  assert.equal(opp.label, "REJECT");
});

test("a low score with no failed rule is not badged 'rejected by risk'", () => {
  const { a, opp } = passingBuy();
  const badge = statusBadgeFor(a, opp);
  assert.notEqual(badge, "REJECTED_BY_RISK");
  assert.notEqual(badge, "SPREAD_TOO_HIGH");
  assert.equal(badge, "LOW_OPPORTUNITY_SCORE");
});

test("the final read stays non-actionable but names the low score, not risk rules", () => {
  const { a, opp } = passingBuy();
  const row = {
    symbol: "EURUSD", timeframe: "M5", recommendedAction: a.recommendedAction,
    confidenceScore: a.confidenceScore, statusBadge: statusBadgeFor(a, opp),
    dataSource: "LIVE_FEED", chartConfirmed: true, opportunity: opp,
    newsContext: { riskLevel: "none", alignsWithScanner: null },
    historicalContext: { available: true, winRate: 55, alignsWithScanner: null },
  } as unknown as ScannerOpportunity;
  const fr = computeFinalRead(row);
  assert.equal(fr.label, "NO_TRADE");
  assert.ok(!fr.reasons.some((r) => /rejected by risk rules/i.test(r)), fr.reasons.join(" | "));
  assert.ok(fr.reasons.some((r) => /opportunity score/i.test(r)), fr.reasons.join(" | "));
});

test("control: a failed risk rule is still REJECTED_BY_RISK", () => {
  const { a, opp } = passingBuy();
  const rejected = { ...a, recommendedAction: "REJECT" as const, rulesFailed: ["spread_acceptable", "min_confidence_60", "trend_strength_>=_40"] };
  assert.equal(statusBadgeFor(rejected, { ...opp, label: "REJECT" }), "REJECTED_BY_RISK");
});
