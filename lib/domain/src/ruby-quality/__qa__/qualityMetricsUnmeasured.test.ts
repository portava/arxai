// Ruby Quality rates with nothing to rate are unknown, not 0%.
//
// winRate, tpRate, slRate, lateRate, explanationAccuracy and each bucket's
// winRate returned 0 when their denominator was 0, so the admin page showed
// "Win rate 0.0%" and "Explanation accuracy 0.0%" with no graded rows, while
// the investor card on the same page showed "Win rate —".
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRubyQualityMetrics, type QualitySampleRow } from "../qualityMetrics.engine.js";

function sample(o: Partial<QualitySampleRow>): QualitySampleRow {
  return {
    symbol: "EURUSD", session: "london", decision: "approve", direction: "BUY",
    outcomeStatus: "WIN", pnlR: 1.5, timingClass: "ON_TIME", exitReason: "TP",
    newsNearby: false, userEntered: true, explanationUsed: true, noTradeCredited: false,
    confidenceScore: 80, edgeScore: 72, spreadAtSignal: 0.8, expectedSlippage: 0.5,
    actualSlippage: 0.5, expectedStartDrawdown: 0.3, actualStartDrawdown: 0.3,
    maxFavorableExcursion: 2.0, maxAdverseExcursion: 0.4, ...o,
  };
}

test("no rows: every rate is unknown (null), not 0", () => {
  const m = computeRubyQualityMetrics([]);
  assert.equal(m.rates.winRate, null);
  assert.equal(m.rates.tpRate, null);
  assert.equal(m.rates.slRate, null);
  assert.equal(m.rates.lateRate, null);
  assert.equal(m.explanationAccuracy, null);
  for (const b of [...m.confidenceVsOutcome, ...m.edgeVsOutcome]) {
    assert.equal(b.winRate, null, `bucket ${b.bucket} has no graded rows`);
  }
});

test("only pending rows: still nothing to rate", () => {
  const m = computeRubyQualityMetrics([sample({ outcomeStatus: "PENDING", exitReason: null, pnlR: null })]);
  assert.equal(m.rates.winRate, null);
  assert.equal(m.rates.tpRate, null);
  assert.equal(m.explanationAccuracy, null);
});

test("each rate is null only when its own denominator is empty", () => {
  // One graded loss, not entered by the user, explanation not used.
  const m = computeRubyQualityMetrics([
    sample({ outcomeStatus: "LOSS", userEntered: false, explanationUsed: false, exitReason: "SL", pnlR: -1 }),
  ]);
  assert.equal(m.rates.winRate, 0, "one graded loss is a measured 0% win rate");
  assert.equal(m.rates.tpRate, null, "no entered trades resolved");
  assert.equal(m.rates.lateRate, null, "no entered trades with timing");
  assert.equal(m.explanationAccuracy, null, "no graded rows used the explanation");
  const bucket = m.confidenceVsOutcome.find((b) => b.total > 0);
  assert.equal(bucket?.winRate, 0);
});
