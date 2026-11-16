// ═══════════════════════════════════════════════════════════════════════════
// candleResponseShape.test.ts — backend shape contract for the chart candle
// payload (Task #367).
//
// GET /api/chart/candles serialises the NormalizedChartCandle[] produced by
// normalizeCandles() (via the truth engine) into its `candles` array. The
// frontend Scanner adapter reads each bar's time from the ISO `openTime` /
// `closeTime` strings. If a backend rename ever dropped those fields (or
// reverted to a numeric `time`), the chart would silently blank for every
// symbol while the backend looked healthy.
//
// These assertions call the REAL normalizeCandles and inspect its output, so a
// backend rename fails THIS test instead of silently blanking the chart. They
// use static fixture bars labelled source="dev" — no DB, network, or live
// provider, and no fixture carries sourceMode="live".
// ═══════════════════════════════════════════════════════════════════════════

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCandles, type NormalizeOptions } from "../candleNormalization.js";
import { mt5TickVolumeEvidence, resolveCandleVolumeEvidence } from "../../candleVolumeEvidence.js";
import type { Candle } from "../../types.js";

export {};

const EPOCH = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z — static, no wall-clock drift
const M5_MS = 5 * 60 * 1000;

function ts(offset = 0): string {
  return new Date(EPOCH + offset).toISOString();
}

function baseOpts(overrides: Partial<NormalizeOptions> = {}): NormalizeOptions {
  return {
    symbol: "SHAPEFX_FIXTURE",
    displaySymbol: "SHAPEFX/FIXTURE",
    timeframe: "M5",
    source: "dev",
    now: EPOCH + M5_MS * 100,
    ...overrides,
  };
}

function bar(openOffset = 0): Candle {
  return { time: ts(openOffset), open: 1.1, high: 1.102, low: 1.099, close: 1.1015 };
}

test("[SHAPE01] every candle carries ISO openTime/closeTime strings (not a numeric `time`)", () => {
  const raw: Candle[] = [bar(0), bar(M5_MS), bar(M5_MS * 2)];
  const { candles } = normalizeCandles(raw, baseOpts());
  assert.equal(candles.length, 3, "all fixture bars must survive normalisation");

  for (const c of candles) {
    // The fields the frontend adapter depends on must exist and be ISO strings.
    assert.equal(typeof c.openTime, "string", "openTime must be a string");
    assert.equal(typeof c.closeTime, "string", "closeTime must be a string");
    assert.ok(
      Number.isFinite(Date.parse(c.openTime)),
      `openTime must parse to a finite epoch (got ${c.openTime})`,
    );
    assert.ok(
      Number.isFinite(Date.parse(c.closeTime)),
      `closeTime must parse to a finite epoch (got ${c.closeTime})`,
    );
    // The bug would silently return if a numeric `time` replaced the ISO fields.
    assert.equal(
      typeof (c as unknown as Record<string, unknown>)["time"],
      "undefined",
      "candle must NOT carry a numeric `time` field — frontend reads openTime/closeTime",
    );
  }
});

test("[SHAPE02] closeTime is exactly one interval after openTime, ascending order", () => {
  const raw: Candle[] = [bar(0), bar(M5_MS), bar(M5_MS * 2)];
  const { candles } = normalizeCandles(raw, baseOpts());

  for (const c of candles) {
    const span = Date.parse(c.closeTime) - Date.parse(c.openTime);
    assert.equal(span, M5_MS, "closeTime - openTime must equal one M5 interval");
  }
  for (let i = 1; i < candles.length; i++) {
    assert.ok(
      Date.parse(candles[i]!.openTime) > Date.parse(candles[i - 1]!.openTime),
      "candles must be ascending by openTime",
    );
  }
});


for (const quantity of [0, 17]) test(`explicit MT5 tick evidence preserves observed ${quantity} ticks`, () => {
  const raw: Candle = { ...bar(), volume: quantity, volumeEvidence: { kind: "tick_count", quantity, unit: "ticks", reason: null } };
  const c = normalizeCandles([raw], baseOpts({ source: "mt5_broker" })).candles[0]!;
  assert.deepEqual(c.volumeEvidence, raw.volumeEvidence);
  assert.equal(c.tickVolume, quantity);
});
for (const volume of [undefined, 0, 50]) test(`legacy numeric volume ${volume} cannot establish volume semantics`, () => {
  const c = normalizeCandles([{ ...bar(), volume }], baseOpts({ source: "mt5_broker" })).candles[0]!;
  assert.equal(c.volumeEvidence?.kind, "unavailable");
  assert.equal(c.volumeEvidence?.quantity, null);
});
for (const source of ["deriv_public", "mock", "assistant_real:twelve_data"]) test(`unsupported ${source} never borrows MT5 volume evidence`, () => {
  const raw: Candle = { ...bar(), volume: 10, volumeEvidence: { kind: "tick_count", quantity: 10, unit: "ticks", reason: null } };
  const c = normalizeCandles([raw], baseOpts({ source })).candles[0]!;
  assert.equal(c.volumeEvidence?.kind, "unavailable");
});

for (const quantity of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "17", null, undefined]) test(`invalid explicit tick quantity ${quantity} is unavailable`, () => {
  assert.equal(mt5TickVolumeEvidence(quantity).kind, "unavailable");
  const raw = { kind: "tick_count", unit: "ticks", quantity, reason: null };
  assert.equal(resolveCandleVolumeEvidence(raw, "mt5_broker").quantity, null);
});
for (const quantity of [0, 10]) test(`unqualified real-volume ${quantity} is withheld rather than called traded volume`, () => {
  assert.equal(resolveCandleVolumeEvidence({ kind: "real_volume", unit: "broker_units", quantity, reason: null }, "mt5_broker").kind, "unavailable");
});
for (const change of [{ unit: "broker_units" }, { reason: "partial" }, { kind: "unavailable" }]) test(`contradicting tick metadata ${JSON.stringify(change)} is unavailable`, () => {
  assert.equal(resolveCandleVolumeEvidence({ ...mt5TickVolumeEvidence(5), ...change }, "mt5_broker").kind, "unavailable");
});
test("duplicate replacement cannot carry the old candle's volume evidence", () => {
  const observed: Candle = { ...bar(), volume: 17, volumeEvidence: mt5TickVolumeEvidence(17) };
  const result = normalizeCandles([observed, { ...bar(), close: 1.1016 }], baseOpts({ source: "mt5_broker" }));
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0]!.volumeEvidence?.kind, "unavailable");
});
