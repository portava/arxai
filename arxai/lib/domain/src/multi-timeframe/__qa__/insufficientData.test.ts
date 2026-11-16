// Multi-timeframe report — a timeframe with too few candles was NOT observed.
//
// detectTrend returned trend "SIDEWAYS", strength 0 for any series shorter than
// 20 bars (including an empty one when the provider is down), and the report
// then read "EURUSD: M5 SIDEWAYS (0), H1 SIDEWAYS (0), H4 SIDEWAYS (0) …
// This analysis describes observed conditions only". Nothing was observed.
// "Sideways" was a default, not a measurement.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReport,
  detectTrend,
  MIN_CANDLES_FOR_TREND,
  type CandleLike,
} from "../index.js";

function series(n: number, start: number, step: number): CandleLike[] {
  const out: CandleLike[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    out.push({ open: c - step / 2, high: c + Math.abs(step), low: c - Math.abs(step), close: c });
  }
  return out;
}

test("detectTrend: an empty or short series is INSUFFICIENT_DATA, never SIDEWAYS", () => {
  for (const n of [0, 1, 19]) {
    const s = detectTrend(series(n, 1.1, 0.0005));
    assert.equal(s.trend, "INSUFFICIENT_DATA", `n=${n}`);
    assert.notEqual(s.trend, "SIDEWAYS");
    assert.equal(s.strength, 0);
    assert.equal(s.candlesUsed, n);
  }
  assert.equal(MIN_CANDLES_FOR_TREND, 20);
});

test("buildReport with no candles: no trend, no alignment, no bias, and says so plainly", () => {
  const r = buildReport({
    symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerCandles: [], middleCandles: [], higherCandles: [],
  });
  for (const tf of [r.lower, r.middle, r.higher]) {
    assert.equal(tf.snapshot.trend, "INSUFFICIENT_DATA");
  }
  assert.equal(r.result.alignmentLabel, "INSUFFICIENT_DATA");
  assert.equal(r.result.bestBias, "NEUTRAL");
  assert.equal(r.result.alignmentScore, 0);
  assert.doesNotMatch(r.aiSummary, /SIDEWAYS/);
  assert.doesNotMatch(r.aiSummary, /observed conditions/i);
  assert.match(r.aiSummary, /not enough candles/i);
  assert.match(r.aiSummary, /M5 0/);
  assert.ok(r.result.conflictWarning && /M5/.test(r.result.conflictWarning));
});

test("buildReport with ONE short timeframe does not classify alignment from the other two", () => {
  const up = series(120, 1.1, 0.0005);
  const r = buildReport({
    symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerCandles: up, middleCandles: up, higherCandles: series(5, 1.1, 0.0005),
  });
  assert.equal(r.lower.snapshot.trend, "UP");
  assert.equal(r.higher.snapshot.trend, "INSUFFICIENT_DATA");
  assert.equal(r.result.alignmentLabel, "INSUFFICIENT_DATA");
  assert.equal(r.result.bestBias, "NEUTRAL");
  assert.match(r.aiSummary, /H4 5/);
});

test("a fully observed report is unchanged (all three timeframes trending up)", () => {
  const up = series(120, 1.1, 0.0005);
  // Current bars: each series' newest bar opened at `now` (bars without a
  // timestamp cannot be confirmed current — see freshness.test.ts).
  const now = Date.UTC(2026, 9, 28, 12, 0);
  const timed = (intervalMs: number) => up.map((c, i) => ({ ...c, time: now - (up.length - 1 - i) * intervalMs }));
  const r = buildReport({
    symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerCandles: timed(5 * 60_000), middleCandles: timed(60 * 60_000), higherCandles: timed(4 * 60 * 60_000),
    nowMs: now,
  });
  assert.equal(r.result.alignmentLabel, "STRONG_BULLISH_ALIGNMENT");
  assert.equal(r.result.bestBias, "BUY");
  assert.match(r.aiSummary, /observed conditions only/);
});
