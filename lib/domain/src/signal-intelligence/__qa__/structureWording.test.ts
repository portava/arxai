// Structure wording — the Market Read sentence must not pair a regime word with
// a contradicting swing-structure word, and must name the closed-bar window it
// ran over.
//
// Owner screenshot 2026-10-27 (V75 1m, Deriv public synthetic data): the
// Market Read card said "V75 is range-bound and looks bullish; a setup is
// forming." while its own evidence said "Higher highs / higher lows". "Range-
// bound" was classifyRegime's RANGING (20-bar normalized slope < 0.0008, which
// a 1m series at ~33,588 almost never exceeds); "bullish" was the swing
// structure. Two classifiers, one sentence, no window.
//
// The regime classifier itself is unchanged here (it feeds scoring and market
// memory); this pins the WORDING to what was measured.
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRubyMarketEdge,
  explainMarketRead,
  type SignalCandle,
  type SignalEngineInput,
} from "../index.js";

const NOW = Date.parse("2026-10-27T16:02:00.000Z");

/** ~120 closed 1m bars near 33,588: a zigzag (period 12, amplitude 60) on a
 * 0.03 %/bar drift — clear higher highs / higher lows, small 20-bar slope. */
function ownerLikeSeries(n = 118, drift = 0.0003): SignalCandle[] {
  const out: SignalCandle[] = [];
  let prev = 33_200;
  for (let i = 0; i < n; i++) {
    const base = 33_200 * (1 + drift * i);
    const close = base + 60 * Math.sin((2 * Math.PI * i) / 12);
    const open = (prev + close) / 2;
    out.push({ open, close, high: Math.max(open, close) + 6, low: Math.min(open, close) - 6, volume: null });
    prev = close;
  }
  return out;
}

/** A flat band: an exactly repeating oscillation well inside 4·ATR, no drift. */
function flatBand(n = 118): SignalCandle[] {
  const out: SignalCandle[] = [];
  let prev = 33_588;
  for (let i = 0; i < n; i++) {
    const close = 33_588 + [0, 2, 4, 2, 0, -2, -4, -2][i % 8]!;
    const open = (prev + close) / 2;
    out.push({ open, close, high: Math.max(open, close) + 12, low: Math.min(open, close) - 12, volume: null });
    prev = close;
  }
  return out;
}

function input(candles: SignalCandle[] | null): SignalEngineInput {
  return {
    symbol: "R_75",
    displayName: "V75",
    timeframe: "M1",
    assetClass: "synthetic",
    candles,
    currentPrice: candles?.at(-1)?.close ?? null,
    dataSource: "LIVE_FEED",
    scanner: null,
    scalp: null,
    execution: null,
    newsRiskLevel: null,
    previous: null,
    now: NOW,
  };
}

test("owner state: HH/HL structure with a small 20-bar drift never reads 'range-bound … bullish'", () => {
  const signal = buildRubyMarketEdge(input(ownerLikeSeries()));
  // Documents the two classifiers disagreeing on the same bars.
  assert.equal(signal.earlyTrend.structure, "HH_HL");
  assert.equal(signal.regime, "RANGING");
  assert.equal(signal.bias, "BULLISH");
  assert.equal(signal.structureWindow, 118);

  const ex = explainMarketRead(signal);
  for (const mode of [ex.simple, ex.advanced]) {
    const s = mode.whatIsHappening;
    assert.doesNotMatch(s, /range-bound/, s);
    assert.doesNotMatch(s, /not yet trending/, s);
    assert.match(s, /higher highs and higher lows/, s);
    assert.match(s, /in the last 118 closed 1m bars/, s);
    assert.match(s, /bullish structure/, s);
    assert.match(s, /net movement over the last 20 closed bars is small/, s);
  }
});

test("a flat band still reads range-bound, and regime and structure agree", () => {
  const signal = buildRubyMarketEdge(input(flatBand()));
  assert.equal(signal.earlyTrend.structure, "RANGE");
  const s = explainMarketRead(signal).simple.whatIsHappening;
  assert.match(s, /^V75 is range-bound — price is held in a tight band in the last 118 closed 1m bars/, s);
  assert.doesNotMatch(s, /bullish|bearish/, s);
});

test("structureWindow is the engine's real input length, null when blind", () => {
  assert.equal(buildRubyMarketEdge(input(ownerLikeSeries(64))).structureWindow, 64);
  const blind = buildRubyMarketEdge(input(ownerLikeSeries(10)));
  assert.equal(blind.structureWindow, null);
  assert.match(explainMarketRead(blind).simple.whatIsHappening, /there isn't enough live data yet/);
});

test("a signal without structureWindow (persisted/older) names no window rather than inventing one", () => {
  const signal = buildRubyMarketEdge(input(ownerLikeSeries()));
  delete (signal as { structureWindow?: number | null }).structureWindow;
  const s = explainMarketRead(signal).simple.whatIsHappening;
  assert.doesNotMatch(s, /closed 1m bars \(/, s);
  assert.doesNotMatch(s, /in the last \d+ closed/, s);
  assert.match(s, /higher highs and higher lows across its recent swings \(bullish structure\)/, s);
});
