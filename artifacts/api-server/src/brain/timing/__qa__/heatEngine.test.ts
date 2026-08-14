// Unit tests for the Heat Score engine. Run via:
//   node --import tsx --test src/brain/timing/__qa__/heatEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-heat`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHeat, type HeatEngineInput } from "../heatEngine.js";

type C = HeatEngineInput["candles"][number];

// A flat candle centred at `price` with total range `range` and a body that is
// `bodyFrac` of the range. `dir` > 0 = bullish close, < 0 = bearish.
function candle(price: number, range: number, bodyFrac = 0.8, dir = 1, volume = 1000): C {
  const half = range / 2;
  const body = range * bodyFrac;
  const open = dir >= 0 ? price - body / 2 : price + body / 2;
  const close = dir >= 0 ? price + body / 2 : price - body / 2;
  return { open, high: price + half, low: price - half, close, volume };
}

// Build `n` identical flat candles.
function series(n: number, range: number, bodyFrac = 0.8): C[] {
  return Array.from({ length: n }, () => candle(100, range, bodyFrac));
}

function baseInput(over: Partial<HeatEngineInput> = {}): HeatEngineInput {
  return {
    symbol: "EURUSD",
    isSynthetic: false,
    candles: series(60, 1, 0.8),
    spread: null,
    mid: null,
    sessionHeatBonus: 5,
    killZoneActive: false,
    newsHeatAdjustment: 0,
    ...over,
  };
}

test("insufficient candle data → COOL, session-only estimate, unknown source", () => {
  const out = computeHeat(baseInput({
    candles: series(5, 1),
    sessionHeatBonus: 25,
    killZoneActive: true,
  }));
  assert.equal(out.heatState, "COOL");
  assert.equal(out.heatScore, 35); // 25 session + 10 kill-zone
  assert.equal(out.heatSource.primary, "unknown");
  assert.equal(out.atrRatio, null);
  assert.equal(out.candleBodyRatio, null);
});

test("expanding ATR + strong body + kill zone → CLEAN_MOMENTUM", () => {
  // baseline range 1, recent range 3 → atrRatio ≈ 3
  const candles = [...series(30, 1, 0.8), ...series(30, 3, 0.8)];
  const out = computeHeat(baseInput({
    candles,
    sessionHeatBonus: 30,
    killZoneActive: true,
  }));
  assert.equal(out.heatState, "CLEAN_MOMENTUM");
  assert.ok(out.heatScore >= 75, `heatScore ${out.heatScore} should be >= 75`);
  assert.ok((out.atrRatio ?? 0) >= 2.0, `atrRatio ${out.atrRatio} should be >= 2.0`);
});

test("sharp ATR contraction over ≥40 candles → COMPRESSION (quiet before storm)", () => {
  // baseline range 3, recent range 1 → atrRatio ≈ 0.33 < 0.6
  const candles = [...series(30, 3, 0.8), ...series(30, 1, 0.8)];
  const out = computeHeat(baseInput({ candles }));
  assert.equal(out.isQuietBeforeStorm, true);
  assert.equal(out.heatState, "COMPRESSION");
});

test("wide spread + weak body → FALSE_HEAT artefact", () => {
  const candles = [...series(59, 1, 0.8), candle(100, 1, 0.1)]; // last candle tiny body
  const out = computeHeat(baseInput({
    candles,
    spread: 5,
    mid: 100, // spreadBps = 5/100*10000 = 500 → high spread
  }));
  assert.equal(out.isFalseHeat, true);
  assert.equal(out.heatState, "FALSE_HEAT");
});

test("quiet flat market → COOL", () => {
  const out = computeHeat(baseInput({
    candles: series(60, 1, 0.2),
    sessionHeatBonus: 5,
  }));
  assert.equal(out.heatState, "COOL");
  assert.ok(out.heatScore < 30, `heatScore ${out.heatScore} should be < 30`);
});

test("synthetic high-spread threshold is wider than forex", () => {
  // spreadBps = 30: above forex (10) but below synthetic (50) → NOT false heat
  const candles = [...series(59, 1, 0.8), candle(100, 1, 0.1)];
  const out = computeHeat(baseInput({
    isSynthetic: true,
    candles,
    spread: 0.3,
    mid: 100, // 30 bps
  }));
  assert.equal(out.isFalseHeat, false);
});
