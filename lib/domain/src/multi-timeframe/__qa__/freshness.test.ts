// Multi-timeframe report — old bars are not a current alignment.
//
// The engine read only OHLC values: the route dropped every bar's timestamp and
// the series' provenance before calling buildReport. On a weekend (or with a
// stalled feed) the newest M5/H1/H4 bars are Friday's, yet the report still
// said "STRONG_BULLISH_ALIGNMENT", best bias BUY, "describes observed
// conditions" — a confident current read built from data two days old.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, assessTimeframeFreshness, type CandleLike } from "../index.js";

const M5 = 5 * 60_000, H1 = 60 * 60_000, H4 = 4 * H1;

// A clean uptrend whose newest bar opened at `newestOpenMs`.
function trend(n: number, intervalMs: number, newestOpenMs: number | null): CandleLike[] {
  const out: CandleLike[] = [];
  for (let i = 0; i < n; i++) {
    const c = 1.1 + i * 0.002;
    const time = newestOpenMs == null ? undefined : new Date(newestOpenMs - (n - 1 - i) * intervalMs).toISOString();
    out.push({ open: c - 0.001, high: c + 0.002, low: c - 0.002, close: c, ...(time ? { time } : {}) });
  }
  return out;
}

const FRI_CLOSE = Date.UTC(2026, 9, 30, 21, 55); // Fri 21:55 UTC
const SUN_NOON = Date.UTC(2026, 10, 1, 12, 0);

function report(nowMs: number, newest: { m5: number | null; h1: number | null; h4: number | null }, sources?: { lower?: string | null; middle?: string | null; higher?: string | null }) {
  return buildReport({
    symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerCandles: trend(60, M5, newest.m5),
    middleCandles: trend(60, H1, newest.h1),
    higherCandles: trend(60, H4, newest.h4),
    nowMs,
    sources,
  });
}

test("current bars still give a strong alignment (control)", () => {
  const now = Date.UTC(2026, 9, 28, 12, 2);
  const r = report(now, { m5: Date.UTC(2026, 9, 28, 12, 0), h1: Date.UTC(2026, 9, 28, 12, 0), h4: Date.UTC(2026, 9, 28, 12, 0) });
  assert.equal(r.result.alignmentLabel, "STRONG_BULLISH_ALIGNMENT");
  assert.equal(r.result.bestBias, "BUY");
  for (const tf of [r.lower, r.middle, r.higher]) assert.equal(tf.snapshot.freshness, "CURRENT");
});

test("a weekend series is never a confident current alignment", () => {
  const r = report(SUN_NOON, { m5: FRI_CLOSE, h1: Date.UTC(2026, 9, 30, 21, 0), h4: Date.UTC(2026, 9, 30, 20, 0) });
  assert.notEqual(r.result.alignmentLabel, "STRONG_BULLISH_ALIGNMENT");
  assert.equal(r.result.alignmentLabel, "DATA_NOT_CURRENT");
  assert.equal(r.result.bestBias, "NEUTRAL");
  assert.equal(r.lower.snapshot.freshness, "STALE");
  assert.equal(r.lower.snapshot.newestBarTime, new Date(FRI_CLOSE).toISOString());
  assert.match(r.result.conflictWarning ?? "", /M5 newest bar opened Fri 21:55 UTC/);
  assert.match(r.result.conflictWarning ?? "", /not a current read/i);
  assert.match(r.aiSummary, /not current/i);
  assert.doesNotMatch(r.aiSummary, /BUY bias/);
});

test("one stale timeframe is enough to withhold the bias", () => {
  const now = Date.UTC(2026, 9, 28, 12, 2);
  const r = report(now, { m5: Date.UTC(2026, 9, 28, 12, 0), h1: Date.UTC(2026, 9, 28, 12, 0), h4: Date.UTC(2026, 9, 27, 0, 0) });
  assert.equal(r.result.alignmentLabel, "DATA_NOT_CURRENT");
  assert.equal(r.higher.snapshot.freshness, "STALE");
  assert.equal(r.lower.snapshot.freshness, "CURRENT");
});

test("bars without timestamps cannot be confirmed current", () => {
  const now = Date.UTC(2026, 9, 28, 12, 2);
  const r = report(now, { m5: null, h1: null, h4: null });
  assert.equal(r.result.alignmentLabel, "DATA_NOT_CURRENT");
  assert.equal(r.result.bestBias, "NEUTRAL");
  for (const tf of [r.lower, r.middle, r.higher]) {
    assert.equal(tf.snapshot.freshness, "UNKNOWN");
    assert.equal(tf.snapshot.newestBarTime, null);
  }
  assert.match(r.result.conflictWarning ?? "", /no timestamp/i);
});

test("each timeframe carries the source that served it", () => {
  const now = Date.UTC(2026, 9, 28, 12, 2);
  const at = Date.UTC(2026, 9, 28, 12, 0);
  const r = report(now, { m5: at, h1: at, h4: at }, { lower: "mt5_broker", middle: "mt5_broker", higher: "deriv" });
  assert.equal(r.lower.snapshot.source, "mt5_broker");
  assert.equal(r.higher.snapshot.source, "deriv");
});

test("assessTimeframeFreshness: current within two bars, stale after, unknown for missing or future times", () => {
  const now = Date.UTC(2026, 9, 28, 12, 2);
  assert.equal(assessTimeframeFreshness("M5", { open: 1, high: 1, low: 1, close: 1, time: new Date(now - 6 * 60_000).toISOString() }, now).freshness, "CURRENT");
  assert.equal(assessTimeframeFreshness("M5", { open: 1, high: 1, low: 1, close: 1, time: new Date(now - 11 * 60_000).toISOString() }, now).freshness, "STALE");
  assert.equal(assessTimeframeFreshness("M5", { open: 1, high: 1, low: 1, close: 1 }, now).freshness, "UNKNOWN");
  assert.equal(assessTimeframeFreshness("M5", { open: 1, high: 1, low: 1, close: 1, time: new Date(now + H1).toISOString() }, now).freshness, "UNKNOWN");
  assert.equal(assessTimeframeFreshness("X9", { open: 1, high: 1, low: 1, close: 1, time: new Date(now).toISOString() }, now).freshness, "UNKNOWN");
  assert.equal(assessTimeframeFreshness("M5", null, now).freshness, "UNKNOWN");
});

test("an insufficient series still reports INSUFFICIENT_DATA first", () => {
  const r = buildReport({
    symbol: "EURUSD", lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerCandles: [], middleCandles: [], higherCandles: [], nowMs: SUN_NOON,
  });
  assert.equal(r.result.alignmentLabel, "INSUFFICIENT_DATA");
});
