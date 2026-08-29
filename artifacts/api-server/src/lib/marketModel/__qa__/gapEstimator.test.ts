// Gap-variance estimator — contract locks.
//
// Pins, offline (pure fixtures, no DB, no network):
//
//   1. EXACT MEASUREMENT — synthetic weekly fixtures with hand-placed
//      Fri-close→Mon-open log-gaps reproduce the known sample stdev to
//      floating-point precision. Within-week bar pairs contribute nothing.
//   2. HONEST FLOOR — below MIN_GAP_SAMPLES the estimate is null WITH a
//      reason, never a number wearing a decimal point.
//   3. CONTINUOUS VENUES — a venue with no session boundary has σ_gap = 0
//      exactly, by construction (a definition, not an estimate).
//   4. DEGENERATE PRINTS — a non-positive price at a boundary drops that
//      sample rather than poisoning the distribution.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/marketModel/__qa__/gapEstimator.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { getTradingCalendar } from "@workspace/markets";
import { estimateGapSigma, MIN_GAP_SAMPLES, type GapCandle } from "../gapEstimator.js";

const FX = getTradingCalendar("EURUSD")!;
const SYN = getTradingCalendar("Volatility 75 Index")!;
const DAY = 86_400_000;

/** Monday 2026-06-01 00:00 UTC — a clean week anchor. */
const MON0 = Date.UTC(2026, 5, 1, 0, 0, 0);

/**
 * D1 fixtures: Mon–Fri bars at 00:00 UTC for `gaps.length` weeks. Every close
 * is 100; each week's Monday OPEN is 100·e^gap so the Fri→Mon log-gap is
 * exactly the requested value. All other opens are 100 (no intra-week gap).
 */
function weeklyFixtures(gaps: readonly number[]): GapCandle[] {
  const out: GapCandle[] = [];
  for (let w = 0; w < gaps.length + 1; w++) {
    for (let d = 0; d < 5; d++) {
      const t = MON0 + w * 7 * DAY + d * DAY;
      // Week w's Monday open carries the (w-1)→w boundary gap.
      const open = d === 0 && w > 0 ? 100 * Math.exp(gaps[w - 1]!) : 100;
      out.push({ time: new Date(t).toISOString(), open, close: 100 });
    }
  }
  return out;
}

function sampleStdev(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varSum = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(varSum / (xs.length - 1));
}

test("hand-placed weekend gaps reproduce the known sample stdev exactly", () => {
  const gaps = [0.004, -0.004, 0.006, -0.002, 0.004, -0.006, 0.002, -0.004];
  const est = estimateGapSigma(weeklyFixtures(gaps), FX);
  assert.equal(est.samples, gaps.length);
  assert.equal(est.provenance, "MEASURED");
  assert.equal(est.reason, null);
  assert.ok(est.sigmaGap !== null);
  assert.ok(
    Math.abs(est.sigmaGap! - sampleStdev(gaps)) < 1e-12,
    `σ_gap must equal the sample stdev of the placed gaps (got ${est.sigmaGap})`,
  );
});

test("within-week bar pairs contribute NOTHING — only boundary crossings count", () => {
  // All gaps zero ⇒ every boundary sample is ln(100/100) = 0 ⇒ σ_gap 0, and
  // the count equals the number of weekly boundaries, not the number of bars.
  const gaps = new Array(10).fill(0);
  const est = estimateGapSigma(weeklyFixtures(gaps), FX);
  assert.equal(est.samples, 10);
  assert.equal(est.sigmaGap, 0);
});

test("below the sample floor the answer is null WITH a reason — never a guess", () => {
  const gaps = new Array(MIN_GAP_SAMPLES - 1).fill(0.004);
  const est = estimateGapSigma(weeklyFixtures(gaps), FX);
  assert.equal(est.sigmaGap, null);
  assert.equal(est.samples, MIN_GAP_SAMPLES - 1);
  assert.equal(est.reason, "INSUFFICIENT_GAP_SAMPLES");
});

test("a continuous venue has σ_gap = 0 by construction (no boundary exists)", () => {
  // No candles needed at all: the venue definition answers the question.
  const est = estimateGapSigma([], SYN);
  assert.equal(est.sigmaGap, 0);
  assert.equal(est.provenance, "NO_SESSION_BOUNDARIES");
  assert.equal(est.reason, null);
});

test("a degenerate boundary print drops the sample rather than poisoning σ", () => {
  const gaps = new Array(MIN_GAP_SAMPLES + 1).fill(0.004);
  const candles = weeklyFixtures(gaps);
  // Corrupt one week's Monday open (a zero print). That sample must vanish;
  // the remaining MIN_GAP_SAMPLES identical gaps still clear the floor.
  const mondayIdx = candles.findIndex(
    (c, i) => i > 0 && new Date(c.time).getUTCDay() === 1 && c.open !== 100,
  );
  assert.ok(mondayIdx > 0);
  candles[mondayIdx] = { ...candles[mondayIdx]!, open: 0 };
  const est = estimateGapSigma(candles, FX);
  assert.equal(est.samples, MIN_GAP_SAMPLES);
  assert.equal(est.sigmaGap, 0); // identical surviving gaps ⇒ zero spread
  assert.equal(est.provenance, "MEASURED");
});

test("empty / unparseable input refuses honestly", () => {
  const empty = estimateGapSigma([], FX);
  assert.equal(empty.sigmaGap, null);
  assert.equal(empty.samples, 0);
  const garbage = estimateGapSigma(
    [{ time: "not-a-time", open: 100, close: 100 }],
    FX,
  );
  assert.equal(garbage.sigmaGap, null);
});
