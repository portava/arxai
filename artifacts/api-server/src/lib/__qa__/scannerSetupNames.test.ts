// Scanner setup names must describe what the analysis actually measured.
//
//  - "choppy" in aiBrain means only that the LAST bar's range is > 1.8x the
//    window average: usually an expansion/breakout bar, not a range or chop.
//  - A WAIT row has no pullback measured; a BUY/SELL row's direction is just the
//    sign of the 30-bar close drift (no continuation/retest detector), so it must
//    not be filed as "Best retest" on the Opportunity Map.
//  - A row whose displayed bias was withheld must not carry a directional name.
//
// Run: node --import tsx --test --test-force-exit src/lib/__qa__/scannerSetupNames.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMarketFromCandles, type AnalysisCandle } from "../aiBrain.js";
import { setupTypeFor } from "../marketScanner.js";
import { categorizeOpportunities, type OpportunityInput } from "@workspace/domain/signal-intelligence";

/** Constructed bars (not market data): `driftPct` total drift over 30 bars. */
function bars(driftPct: number, lastRangeMult = 1): AnalysisCandle[] {
  return Array.from({ length: 30 }, (_, i) => {
    const c = 1.1 * (1 + (driftPct / 100) * (i / 29));
    const half = 0.0001 * (i === 29 ? lastRangeMult : 1);
    return { o: c - 0.00002, h: c + half, l: c - half, c };
  });
}
function analyse(candles: AnalysisCandle[], spread = 0.00001) {
  return analyzeMarketFromCandles("EURUSD", "M5", candles, { mid: candles.at(-1)!.c, spread }, "LIVE_FEED");
}

test("(a) a range-expansion last bar is not named 'Range / chop'", () => {
  const a = analyse(bars(0.1, 4));
  assert.equal(a.marketBias, "choppy", "fixture: the analyser's volatility-ratio branch");
  const setup = setupTypeFor(a);
  assert.doesNotMatch(setup, /range|chop/i, setup);
  assert.doesNotMatch(a.reasonForTrade, /choppy/i, a.reasonForTrade);
});

test("(b) a WAIT row is not named 'Pullback watch' (no pullback is measured)", () => {
  const a = analyse(bars(0.06));
  assert.equal(a.recommendedAction, "WAIT");
  assert.doesNotMatch(setupTypeFor(a), /pullback|retest/i);
});

test("(c) a BUY drift row is not filed as a retest on the Opportunity Map", () => {
  const a = analyse(bars(0.1));
  assert.equal(a.recommendedAction, "BUY");
  const setupType = setupTypeFor(a);
  assert.doesNotMatch(setupType, /continuation|retest|pullback/i, setupType);
  const input: OpportunityInput = {
    symbol: "EURUSD", displayName: "EURUSD", direction: "BUY", recommendedAction: "BUY", setupType,
    edgeScore: 70, entryQuality: 75, executionQuality: 80, newsRisk: "none", hasLiveData: true, isLate: false, reason: null,
  };
  const map = categorizeOpportunities([input]);
  assert.notEqual(map.rows[0]?.kind, "RETEST");
  assert.equal(map.best.bestRetest, null);
});

test("(d) a rejected row (rules failed) is not named 'Trend continuation'", () => {
  const a = analyse(bars(0.06), 0.00044); // weak trend + wide spread + low confidence
  assert.equal(a.recommendedAction, "REJECT");
  assert.doesNotMatch(setupTypeFor(a), /continuation/i);
});

test("the reason does not claim 'spread ok' when the spread rule failed", () => {
  const a = analyse(bars(0.1), 0.00044);
  assert.ok(a.rulesFailed.includes("spread_acceptable"), a.rulesFailed.join(","));
  assert.doesNotMatch(a.reasonForTrade, /spread ok/i, a.reasonForTrade);
});

test("a row whose bias is withheld gets a non-directional setup name", () => {
  const a = analyse(bars(0.1));
  const setup = setupTypeFor(a, false);
  assert.doesNotMatch(setup, /upward|downward|bull|bear|trend|continuation/i, setup);
});
