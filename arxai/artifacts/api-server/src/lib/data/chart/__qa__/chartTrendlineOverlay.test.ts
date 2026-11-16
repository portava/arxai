// Task #651 — Chart Trendline Overlay: OFFLINE pure producer suite.
//
// Locks the DISPLAY-ONLY overlay producer that turns the EXISTING trendline truth
// verdict (Task #649) into drawable geometry for the ARX native chart. The suite
// asserts:
//   1. Determinism — same candles + facts ⇒ byte-identical overlay.
//   2. Honesty fail-closed — a too-short window ⇒ insufficient + hidden.
//   3. Honesty fail-closed — feed NOT live-confirmed ⇒ hidden (contextOnly), even
//      when a real trendline is detected.
//   4. No fabricated geometry — when visible, every line endpoint sits on a REAL
//      candle openTime (Unix seconds) drawn from the input window, start < end.
//
// No DB, no live providers — pure function over fixture candles. Runs in the
// offline `ci` lane. Wired as
// `pnpm --filter @workspace/api-server run test:chart-trendline-overlay`.
//
// Run: node --import tsx --test src/lib/data/chart/__qa__/chartTrendlineOverlay.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChartTrendlineOverlay,
  type ChartTrendlineOverlayFacts,
} from "../chartTrendlineOverlay.js";
import type { NormalizedChartCandle } from "../candleNormalization.js";

const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const FIVE_MIN_MS = 5 * 60_000;

function candle(
  i: number,
  ohlc: { open: number; high: number; low: number; close: number },
  over: Partial<NormalizedChartCandle> = {},
): NormalizedChartCandle {
  const openMs = BASE_MS + i * FIVE_MIN_MS;
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(openMs + FIVE_MIN_MS).toISOString(),
    open: ohlc.open,
    high: ohlc.high,
    low: ohlc.low,
    close: ohlc.close,
    volume: 0,
    tickVolume: null,
    source: "test",
    sourceMode: "live",
    priceBasis: "MID",
    providerSymbol: "EUR/USD",
    brokerSymbol: null,
    isComplete: true,
    isFinal: true,
    isForming: false,
    receivedAt: new Date(openMs).toISOString(),
    qualityFlags: [],
    ...over,
  } as NormalizedChartCandle;
}

// A clean, deterministic rising channel: swing lows print at phase 0 of each
// 6-bar cycle, swing highs at phase 3, both rising at the same slope — so the
// detector fits a parallel channel (real geometry, no fabrication).
function risingChannel(n = 42): NormalizedChartCandle[] {
  const out: NormalizedChartCandle[] = [];
  for (let i = 0; i < n; i++) {
    const lower = 100 + 0.4 * i;
    const phase = i % 6;
    const osc = (1 - Math.cos((2 * Math.PI * phase) / 6)) / 2; // 0 at phase0, 1 at phase3
    const mid = lower + 4 * osc;
    out.push(
      candle(i, { open: mid, high: mid + 0.2, low: mid - 0.2, close: mid }),
    );
  }
  return out;
}

const LIVE_FACTS: ChartTrendlineOverlayFacts = {
  feedConfirmed: true,
  feedStale: false,
  sufficiencyAllowsSetup: true,
  chartReadConfidenceLow: false,
};

// ── 1. Determinism ───────────────────────────────────────────────────────────
test("1: same candles + facts produce byte-identical overlays", () => {
  const candles = risingChannel();
  const a = buildChartTrendlineOverlay(candles, LIVE_FACTS);
  const b = buildChartTrendlineOverlay(candles, LIVE_FACTS);
  assert.deepEqual(a, b);
});

// ── 2. Fail closed on a too-short window ─────────────────────────────────────
test("2: a window shorter than the detector minimum is insufficient + hidden", () => {
  const candles = risingChannel(8);
  const o = buildChartTrendlineOverlay(candles, LIVE_FACTS);
  assert.equal(o.insufficient, true);
  assert.equal(o.visible, false);
  assert.equal(o.lines.length, 0);
  assert.equal(o.markers.length, 0);
});

// ── 3. Fail closed when the feed is not live-confirmed ───────────────────────
test("3: feed not live-confirmed hides the overlay (contextOnly), no geometry", () => {
  const candles = risingChannel();
  const o = buildChartTrendlineOverlay(candles, {
    ...LIVE_FACTS,
    feedConfirmed: false,
    feedStale: true,
  });
  assert.equal(o.visible, false);
  assert.equal(o.lines.length, 0);
  assert.equal(o.markers.length, 0);
});

// ── 4. Visible geometry uses ONLY real candle times, start < end ─────────────
test("4: a detected, live-confirmed channel draws lines on real candle times", () => {
  const candles = risingChannel();
  const o = buildChartTrendlineOverlay(candles, LIVE_FACTS);

  // The fixture is engineered to produce a channel; if the detector ever stops
  // detecting it this assertion makes the regression loud rather than silent.
  assert.equal(o.visible, true, `expected a visible overlay; note=${o.note}`);
  assert.ok(o.lines.length > 0, "expected at least one drawable line");

  // Every endpoint time must be a REAL candle openTime (Unix seconds) from the
  // input window — never a fabricated coordinate — and ascending.
  const realTimes = new Set(
    candles.map((c) => Math.floor(new Date(c.openTime).getTime() / 1000)),
  );
  for (const ln of o.lines) {
    assert.ok(realTimes.has(ln.start.time), "start.time is a real candle time");
    assert.ok(realTimes.has(ln.end.time), "end.time is a real candle time");
    assert.ok(ln.start.time < ln.end.time, "endpoints are time-ordered");
    assert.ok(Number.isFinite(ln.start.price), "start.price finite");
    assert.ok(Number.isFinite(ln.end.price), "end.price finite");
  }

  // Markers (if any) must also anchor to a real candle time.
  for (const m of o.markers) {
    assert.ok(realTimes.has(m.time), "marker.time is a real candle time");
    assert.ok(Number.isFinite(m.price), "marker.price finite");
  }
});

// ── 5. A flat / structureless window detects no trendline and stays hidden ───
test("5: a flat window yields no trendline and an honest hidden overlay", () => {
  const candles = Array.from({ length: 42 }, (_, i) =>
    candle(i, { open: 100, high: 100.01, low: 99.99, close: 100 }),
  );
  const o = buildChartTrendlineOverlay(candles, LIVE_FACTS);
  assert.equal(o.visible, false);
  assert.equal(o.lines.length, 0);
});
