// Ruby Quality: each row counts once, Best and Worst never list the same
// symbol, and "Pending — awaiting real evidence" holds only PENDING rows.
//
// The bucket test was `v >= lo && v <= hi`, so a confidence of exactly 75
// counted in both "60-75" and "75-90". bestSymbols = slice(0, 5) and
// worstSymbols = slice(-5) listed the same symbols whenever fewer than ten
// were graded. pending = rows − resolved also counted UNRESOLVED rows, which
// are not awaiting evidence.
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
const sum = (xs: { total: number }[]) => xs.reduce((a, b) => a + b.total, 0);

test("a boundary value lands in exactly one bucket", () => {
  const rows = [
    sample({ confidenceScore: 75, edgeScore: 70 }),
    sample({ confidenceScore: 60, edgeScore: 50, outcomeStatus: "LOSS", pnlR: -1 }),
    sample({ confidenceScore: 90, edgeScore: 85 }),
    sample({ confidenceScore: 100, edgeScore: 100 }),
    sample({ confidenceScore: 0, edgeScore: 0, outcomeStatus: "LOSS", pnlR: -1 }),
  ];
  const m = computeRubyQualityMetrics(rows);
  assert.equal(sum(m.confidenceVsOutcome), m.totals.graded);
  assert.equal(sum(m.edgeVsOutcome), m.totals.graded);
  const conf = Object.fromEntries(m.confidenceVsOutcome.map((b) => [b.bucket, b.total]));
  assert.deepEqual(conf, { "0-60": 1, "60-75": 1, "75-90": 1, "90-100": 2 });
});

test("with few graded symbols, Best and Worst never list the same one", () => {
  for (const n of [1, 2, 3, 5, 9, 10, 12]) {
    const rows = Array.from({ length: n }, (_, i) =>
      sample({ symbol: `SYM${i}`, outcomeStatus: i % 2 ? "LOSS" : "WIN", pnlR: i % 2 ? -1 : 1 }));
    const m = computeRubyQualityMetrics(rows);
    const best = new Set(m.bestSymbols.map((s) => s.key));
    const overlap = m.worstSymbols.filter((s) => best.has(s.key)).map((s) => s.key);
    assert.deepEqual(overlap, [], `${n} symbols: ${overlap.join(",")} in both lists`);
    assert.ok(m.bestSymbols.length <= 5 && m.worstSymbols.length <= 5);
    if (n >= 2) assert.ok(m.worstSymbols.length >= 1, `${n} symbols: a worst symbol is still shown`);
  }
  const two = computeRubyQualityMetrics([
    sample({ symbol: "AAA" }),
    sample({ symbol: "BBB", outcomeStatus: "LOSS", pnlR: -1 }),
  ]);
  assert.deepEqual(two.bestSymbols.map((s) => s.key), ["AAA"]);
  assert.deepEqual(two.worstSymbols.map((s) => s.key), ["BBB"]);
});

test("sessions follow the same rule", () => {
  const m = computeRubyQualityMetrics([sample({ session: "london" })]);
  assert.equal(m.bestSessions.length, 1);
  assert.equal(m.worstSessions.length, 0);
});

test("Pending counts only PENDING rows; UNRESOLVED is counted on its own", () => {
  const m = computeRubyQualityMetrics([
    sample({}),
    sample({ outcomeStatus: "PENDING", exitReason: null, pnlR: null }),
    sample({ outcomeStatus: "UNRESOLVED", exitReason: null, pnlR: null }),
    sample({ outcomeStatus: "UNRESOLVED", exitReason: null, pnlR: null }),
  ]);
  assert.equal(m.totals.pending, 1);
  assert.equal(m.totals.unresolved, 2);
  assert.equal(m.totals.resolved, 1);
  assert.equal(m.totals.tracked, m.totals.resolved + m.totals.pending + m.totals.unresolved);
});
