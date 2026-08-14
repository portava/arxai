// Unit tests for the Trap-Probability / Room-To-Move engine. Run via:
//   node --import tsx --test src/brain/timing/__qa__/trapRoomEngine.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:timing-trap`)

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrapAndRoom, type TrapRoomInput } from "../trapRoomEngine.js";

type C = TrapRoomInput["candles"][number];

// A solid-body flat candle (body/range ≈ 0.6) — avoids accidental
// weak-follow-through scoring.
function solid(price = 100, range = 1, dir = 1, volume = 1000): C {
  const body = range * 0.6;
  const open = dir >= 0 ? price - body / 2 : price + body / 2;
  const close = dir >= 0 ? price + body / 2 : price - body / 2;
  return { open, high: price + range / 2, low: price - range / 2, close, volume };
}

function solidSeries(n: number, dir = 1): C[] {
  return Array.from({ length: n }, () => solid(100, 1, dir));
}

function baseInput(over: Partial<TrapRoomInput> = {}): TrapRoomInput {
  return {
    candles: solidSeries(50),
    spread: null,
    mid: null,
    isSynthetic: false,
    killZoneActive: false,
    fakeoutRisk: 0,
    atrRatio: 1.0,
    heatState: "WAKE_UP",
    broadFlowVerdict: "ALIGNED",
    ...over,
  };
}

test("insufficient candles → trap probability falls back to fakeout risk, neutral room/pressure", () => {
  const out = computeTrapAndRoom(baseInput({ candles: solidSeries(10), fakeoutRisk: 42 }));
  assert.equal(out.trapProbability, 42);
  assert.deepEqual(out.trapTypes, []);
  assert.equal(out.roomToMove, 50);
  assert.equal(out.buyPressure, 50);
  assert.equal(out.sellPressure, 50);
});

test("sweep above prior-day high closing back below → PDH_SWEEP_BEARISH", () => {
  const candles = solidSeries(39);
  // PDH from candles.slice(-40,-20) is ~100.5; spike the last candle above it
  // but close back below, with a solid body to avoid weak-follow-through.
  candles.push({ open: 101.8, high: 102, low: 99.9, close: 100, volume: 1000 });
  const out = computeTrapAndRoom(baseInput({ candles }));
  assert.ok(out.trapTypes.includes("PDH_SWEEP_BEARISH"), `types: ${out.trapTypes.join(",")}`);
  assert.ok(out.trapProbability >= 35, `trapProbability ${out.trapProbability} should be >= 35`);
});

test("low body/range ratio → WEAK_FOLLOW_THROUGH", () => {
  const candles = solidSeries(19);
  candles.push({ open: 100, high: 101, low: 99, close: 100.05, volume: 1000 }); // body 0.05 / range 2
  const out = computeTrapAndRoom(baseInput({ candles }));
  assert.ok(out.trapTypes.includes("WEAK_FOLLOW_THROUGH"), `types: ${out.trapTypes.join(",")}`);
});

test("wide spread → SPREAD_WIDENING", () => {
  const out = computeTrapAndRoom(baseInput({
    candles: solidSeries(20),
    spread: 5,
    mid: 100, // 500 bps > 12 forex threshold
  }));
  assert.ok(out.trapTypes.includes("SPREAD_WIDENING"), `types: ${out.trapTypes.join(",")}`);
});

test("conflicted broad flow → BROAD_FLOW_CONFLICT", () => {
  const out = computeTrapAndRoom(baseInput({ candles: solidSeries(20), broadFlowVerdict: "CONFLICTED" }));
  assert.ok(out.trapTypes.includes("BROAD_FLOW_CONFLICT"), `types: ${out.trapTypes.join(",")}`);
});

test("synthetic spread threshold is wider — same bps that traps forex does not trap synthetics", () => {
  const forex = computeTrapAndRoom(baseInput({ candles: solidSeries(20), spread: 0.3, mid: 100 })); // 30 bps
  const synth = computeTrapAndRoom(baseInput({ candles: solidSeries(20), spread: 0.3, mid: 100, isSynthetic: true }));
  assert.ok(forex.trapTypes.includes("SPREAD_WIDENING"));
  assert.ok(!synth.trapTypes.includes("SPREAD_WIDENING"));
});

test("all-bullish candles → buy pressure dominant", () => {
  const out = computeTrapAndRoom(baseInput({ candles: solidSeries(20, 1) }));
  assert.equal(out.buyPressure, 100);
  assert.equal(out.sellPressure, 0);
});
