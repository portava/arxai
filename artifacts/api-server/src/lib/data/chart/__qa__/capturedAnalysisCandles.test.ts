import { test } from "node:test";
import assert from "node:assert/strict";
import { capturedAnalysisCandles } from "../capturedAnalysisCandles.js";
import type { NormalizedChartCandle } from "../candleNormalization.js";
import { higherTimeframeOf } from "../../../assistant/chartStructure.js";
import { analyzeChartStructure } from "../../../assistant/chartStructure.js";
import { normalizeCandles } from "../candleNormalization.js";
import { parsePolygonFxCustomBars, isOriginalPolygonEvidence } from "../../../assistant/polygonFxCandles.js";
import { capturedHigherTimeframePivot } from "../marketIntelligenceService.js";
import type { ChartFeedStatus } from "../chartDataService.js";

const candle = (extra: Partial<NormalizedChartCandle> = {}): NormalizedChartCandle => ({
  symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M5",
  openTime: "2026-11-01T10:00:00.000Z", closeTime: "2026-11-01T10:05:00.000Z",
  open: 100, high: 102, low: 99, close: 101, volume: 0, tickVolume: null,
  source: "assistant_real:unknown", sourceMode: "unknown", priceBasis: "UNKNOWN",
  providerSymbol: null, brokerSymbol: null, isComplete: true, isFinal: true, isForming: false,
  receivedAt: "2026-11-01T10:06:00.000Z", qualityFlags: [], ...extra,
});

test("already-normalized open time is used once, including close-based original providers", () => {
  const input = candle();
  const [out] = capturedAnalysisCandles([input]);
  assert.equal(out!.time, input.openTime);
  assert.deepEqual([out!.open, out!.high, out!.low, out!.close], [100, 102, 99, 101]);
});

test("higher timeframe mapping accepts canonical requests and legacy aliases consistently", () => {
  for (const [canonical, alias, higher] of [["M1", "1m", "M15"], ["M5", "5m", "H1"], ["M15", "15m", "H1"], ["M30", "30m", "H4"], ["H1", "1h", "H4"], ["H4", "4h", "D1"], ["D1", "1d", "W1"]]) {
    assert.equal(higherTimeframeOf(canonical!), higher);
    assert.equal(higherTimeframeOf(alias!), higher);
  }
  for (const unmapped of ["W1", "1w", "MN1", "M2", "invalid", ""]) assert.equal(higherTimeframeOf(unmapped), null);
});

test("missing HTF observation is not narrated as an assessed lack of directional edge", () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ time: new Date(Date.UTC(2026, 9, 30, 0, i * 5)).toISOString(), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));
  const unassessed = analyzeChartStructure(bars, { htfBias: null });
  assert.equal(unassessed.htfBias, "Not assessed");
  assert.match(unassessed.why, /not assessed/);
  const assessed = analyzeChartStructure(bars, { htfBias: "No clear edge" });
  assert.equal(assessed.htfBias, "No clear edge");
  assert.match(assessed.why, /unclear/);
});

test("classic pivots use the latest closed bar only on an actual qualifying period", () => {
  const htfCandles = capturedAnalysisCandles([candle({ high: 110, low: 90, close: 100 }), candle({ high: 120, low: 100, close: 110 })]);
  const htfFeedStatus = { aiUsable: true, stale: false } as ChartFeedStatus;
  for (const [htfTimeframe, label] of [["D1", "daily"], ["W1", "weekly"], ["MN1", "monthly"]] as const) {
    assert.deepEqual(capturedHigherTimeframePivot({ htfCandles, htfFeedStatus, htfTimeframe }), { prior: { high: 120, low: 100, close: 110 }, pivotSourceTimeframe: label });
  }
  for (const htfTimeframe of ["M15", "H1", "H4", null] as const) {
    assert.equal(capturedHigherTimeframePivot({ htfCandles, htfFeedStatus, htfTimeframe }).prior, null);
  }
  for (const status of [null, { ...htfFeedStatus, aiUsable: false }, { ...htfFeedStatus, stale: true }]) {
    assert.equal(capturedHigherTimeframePivot({ htfCandles, htfFeedStatus: status, htfTimeframe: "D1" }).prior, null);
  }
  assert.equal(capturedHigherTimeframePivot({ htfCandles: [], htfFeedStatus, htfTimeframe: "D1" }).prior, null);
});

test("audited original metadata survives capture as description without minting fresh producer authority", () => {
  const day = Date.UTC(2026, 9, 30);
  const parsed = parsePolygonFxCustomBars({ status: "OK", ticker: "C:EURUSD", results: [{ t: day, o: 1, h: 1.2, l: .9, c: 1.1 }] }, {
    ticker: "C:EURUSD", timeframe: "M5", fromMs: day, toMs: day + 86_399_999, nowMs: day + 600_000, maxBars: 200,
  });
  assert.ok(parsed.ok);
  const p = parsed.candles[0]!;
  const raw = { time: p.t, open: p.o, high: p.h, low: p.l, close: p.c, timeBasisEvidence: p.timeBasisEvidence, priceBasisEvidence: p.priceBasisEvidence };
  const context = { candle: raw, symbol: "EURUSD", timeframe: "M5" };
  assert.equal(isOriginalPolygonEvidence(raw.timeBasisEvidence, "assistant_real:polygon", context, "time"), true);
  const normalized = normalizeCandles([raw], { symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M5", source: "assistant_real:polygon", now: day + 600_000 }).candles;
  const captured = structuredClone(normalized);
  const [converted] = capturedAnalysisCandles(captured);
  assert.equal(converted!.time, raw.time);
  assert.equal(converted!.timeBasisEvidence?.kind, "original_utc");
  assert.equal(converted!.priceBasisEvidence?.basis, "BID");
  assert.equal(converted!.volume, undefined);
  assert.equal(isOriginalPolygonEvidence(converted!.timeBasisEvidence, "assistant_real:polygon", { ...context, candle: converted! }, "time"), false);
});

test("incomplete and contradictory forming bars cannot enter assessment OHLC", () => {
  assert.deepEqual(capturedAnalysisCandles([
    candle(), candle({ isComplete: false }), candle({ isComplete: true, isForming: true, close: 999 }),
  ]).map(c => c.close), [101]);
});

test("legacy volume zero and unavailable quantity never become measured zero volume", () => {
  for (const extra of [{}, { volumeEvidence: { kind: "unavailable" as const, quantity: null, unit: null, reason: "Missing" } }]) {
    const [out] = capturedAnalysisCandles([candle(extra)]);
    assert.equal(Object.hasOwn(out!, "volume"), false);
  }
});

test("qualified normalized tick and trade quantities retain their distinct units, including true zero", () => {
  for (const [kind, unit] of [["tick_count", "ticks"], ["real_volume", "provider_trade_units"]] as const) {
    for (const quantity of [0, 15]) {
      const input = candle({ volumeEvidence: { kind, unit, quantity, reason: null } });
      const [out] = capturedAnalysisCandles([input]);
      assert.equal(out!.volume, quantity);
      assert.deepEqual(out!.volumeEvidence, input.volumeEvidence);
    }
  }
});

test("time/price/volume limitations remain separate copied metadata, not new provider authority", () => {
  const input = candle({
    timeBasisEvidence: { kind: "unavailable", basis: "BROKER_SERVER", authority: null, reason: "Historical mapping unverified" },
    priceBasisEvidence: { kind: "unavailable", basis: null, reason: "No original price basis" },
    volumeEvidence: { kind: "tick_count", unit: "ticks", quantity: 3, reason: null },
  });
  const [out] = capturedAnalysisCandles([input]);
  assert.deepEqual(out!.timeBasisEvidence, input.timeBasisEvidence);
  assert.deepEqual(out!.priceBasisEvidence, input.priceBasisEvidence);
  out!.timeBasisEvidence!.reason = "caller edit";
  out!.volumeEvidence!.quantity = 999;
  out!.close = 800;
  assert.equal(input.timeBasisEvidence!.reason, "Historical mapping unverified");
  assert.equal(input.volumeEvidence!.quantity, 3);
  assert.equal(input.close, 101);
  assert.equal(Object.hasOwn(out!, "originalVolumeSeriesIdentity"), false);
});
