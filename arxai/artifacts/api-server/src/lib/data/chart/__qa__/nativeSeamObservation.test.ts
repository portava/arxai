// Synthetic fixtures only: verify evidence isolation, never a live accuracy claim.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { recordNativeSeamObservation, withNativeSeamEvidence, __resetNativeSeamObservations, NATIVE_SEAM_TTL_MS, type NativeSeamObservation } from "../nativeSeamObservation.js";
import { runCandleTruth } from "../candleTruthEngine.js";
import { isMergeSeamMeasured, computeChartTruthScore } from "../chartTruthScore.js";
import type { ChartSeriesAttribution } from "../brokerQuoteBinding.js";
import type { Candle } from "../../types.js";

const now = Date.UTC(2026, 10, 5, 18, 4, 30), open = Date.UTC(2026, 10, 5, 18);
const writer = { userId: 70, bridgeConnectionId: 7 };
const series: ChartSeriesAttribution = { ...writer, providerId: "mt5_broker", subProviderId: null, environment: "unknown", brokerSymbol: "EURUSD.native" };
function observation(): NativeSeamObservation { return {
  symbol: "EURUSD", brokerSymbol: "EURUSD.native", timeframe: "M5", collectedAtEpochMs: now,
  brokerServerTimeEpochMs: now, brokerUtcOffsetMs: 0,
  lastClosed: { openTimeEpochMs: open - 300_000, open: 1.1, high: 1.12, low: 1.09, close: 1.11 },
  forming: { openTimeEpochMs: open, open: 1.11, high: 1.13, low: 1.10, close: 1.12 },
}; }
function candles(o = observation()): Candle[] { return Array.from({ length: 200 }, (_, i) => ({
  brokerSymbol: o.brokerSymbol, time: new Date(o.lastClosed.openTimeEpochMs - (199-i)*300_000).toISOString(),
  open: o.lastClosed.open, high: o.lastClosed.high, low: o.lastClosed.low, close: o.lastClosed.close,
})); }
function truth(bars = candles(), timeframe: "M5" | "MN1" = "M5", clock = now) { return runCandleTruth(bars, {
  symbol: "EURUSD", displaySymbol: "EURUSD", timeframe, source: "mt5_broker", assetClass: "forex", limit: 200, now: clock,
}).truthResult; }
beforeEach(__resetNativeSeamObservations);

test("only exact native ingress delegates browser-session gating to per-user bridge auth", async () => {
  const { requireAuthOrPublic } = await import("../../../auth/globalGate.js");
  for (const [path, allowed] of [["/bridge/v2/native-seams", true], ["/bridge/v2/native-seams/other", false],
    ["/bridge/v2/native-seams-other", false], ["/bridge/v2/private", false]] as const) {
    let next = false, status = 0;
    const response = { status: (code: number) => { status = code; return response; }, json: () => {} };
    requireAuthOrPublic({ path, method: "POST" } as never, response as never, () => { next = true; });
    assert.equal(next, allowed); if (!allowed) assert.equal(status, 401);
  }
});

test("unrecognized metadata is never copied or retained with native observations", () => {
  const raw = { ...observation(), irrelevant: () => { throw new Error("must not copy unrelated fields"); } };
  // A whole-object structuredClone would throw on this synthetic probe.
  assert.equal(recordNativeSeamObservation(raw, writer, now).accepted, true);
  raw.lastClosed.close = 99;
  const bars = candles();
  assert.equal(withNativeSeamEvidence(truth(bars), bars, series, now).mergeSeam.nativeObservation?.kind, "mt5_shift1_shift0");
});

test("native pair measures only seam metadata; analytical bars, counts and OHLC remain unchanged", () => {
  const bars = candles(), original = truth(bars), bytes = JSON.stringify({ bars, original });
  assert.equal(isMergeSeamMeasured(original), false);
  assert.equal(recordNativeSeamObservation(observation(), writer, now).accepted, true);
  const measured = withNativeSeamEvidence(original, bars, series, now);
  assert.equal(isMergeSeamMeasured(measured), true);
  assert.equal(measured.mergeSeam.seamGapIntervals, 0);
  assert.equal(measured.mergeSeam.nativeObservation?.kind, "mt5_shift1_shift0");
  assert.equal(JSON.stringify(measured.mergeSeam).includes("userId"), false);
  assert.equal(JSON.stringify(measured.mergeSeam).includes("bridgeConnectionId"), false);
  assert.equal(measured.candleCount, original.candleCount);
  assert.deepEqual({ ...measured, mergeSeam: original.mergeSeam }, original);
  assert.equal(JSON.stringify({ bars, original }), bytes);
});

test("different writer, native symbol, provider and historical subsource cannot borrow seam evidence", () => {
  recordNativeSeamObservation(observation(), writer, now);
  const original = truth(), bars = candles();
  for (const change of [{ userId: 71 }, { bridgeConnectionId: 8 }, { brokerSymbol: "EURUSD" },
    { providerId: "deriv" }, { subProviderId: "durable_mirror" }, { subProviderId: "stored_history" }, { brokerSymbol: null }]) {
    assert.equal(withNativeSeamEvidence(original, bars, { ...series, ...change }, now), original);
  }
});

test("closed timestamp, OHLC and every native symbol must reconcile exactly", () => {
  recordNativeSeamObservation(observation(), writer, now);
  for (const change of [{ time: new Date(open - 600_000).toISOString() }, { open: 1.10001 }, { high: 1.12001 },
    { low: 1.09001 }, { close: 1.11001 }, { brokerSymbol: "EURUSD.other" }]) {
    const bars = candles(); Object.assign(bars.at(-1)!, change); const original = truth(bars);
    assert.equal(withNativeSeamEvidence(original, bars, series, now), original);
  }
});

test("stale or future observation, invalid OHLC and contradictory clock are rejected", () => {
  const variants: Partial<NativeSeamObservation>[] = [
    { collectedAtEpochMs: now - NATIVE_SEAM_TTL_MS - 1 }, { collectedAtEpochMs: now + 5001 },
    { brokerServerTimeEpochMs: now + 60_000 }, { brokerUtcOffsetMs: 0.5 },
    { forming: { ...observation().forming, high: 1 } },
    { forming: { ...observation().forming, close: Number.NaN } },
    { lastClosed: { ...observation().lastClosed, openTimeEpochMs: open } },
  ];
  for (const patch of variants) assert.equal(recordNativeSeamObservation({ ...observation(), ...patch }, writer, now).accepted, false);
});

test("replay cannot refresh observation age; pair expires at forming-bar rollover", () => {
  assert.equal(recordNativeSeamObservation(observation(), writer, now).accepted, true);
  assert.equal(recordNativeSeamObservation(observation(), writer, now + 1).reason, "OBSERVATION_NOT_NEWER");
  const original = truth();
  assert.equal(withNativeSeamEvidence(original, candles(), series, open + 300_000), original);
  assert.equal(withNativeSeamEvidence(original, candles(), series, now + NATIVE_SEAM_TTL_MS + 1), original);
});

test("clock offset keeps native times unchanged and checks current bar on its own coordinate", () => {
  const o = observation(), offset = 2*3_600_000;
  o.brokerUtcOffsetMs = offset; o.brokerServerTimeEpochMs += offset;
  o.lastClosed.openTimeEpochMs += offset; o.forming.openTimeEpochMs += offset;
  assert.equal(recordNativeSeamObservation(o, writer, now).accepted, true);
  const bars = candles(o), measured = withNativeSeamEvidence(truth(bars), bars, series, now);
  assert.equal(measured.mergeSeam.nativeObservation?.formingOpenEpochMs, open + offset);
});

test("same-read clock offset can include a one-second sampling skew without rounding it", () => {
  const o = observation(); o.brokerUtcOffsetMs = 1000; o.brokerServerTimeEpochMs += 1000;
  assert.equal(recordNativeSeamObservation(o, writer, now).accepted, true);
});

test("native missing interval is reported as a gap, not silently marked clean", () => {
  const o = observation(); o.lastClosed.openTimeEpochMs -= 300_000;
  recordNativeSeamObservation(o, writer, now); const bars = candles(o);
  const measured = withNativeSeamEvidence(truth(bars), bars, series, now);
  assert.equal(measured.mergeSeam.gapAtSeam, true); assert.equal(measured.mergeSeam.seamGapIntervals, 1);
});

test("a sub-interval misalignment is unmeasured, never rounded into a clean seam", () => {
  const o = observation(); o.lastClosed.openTimeEpochMs -= 1000;
  recordNativeSeamObservation(o, writer, now); const bars = candles(o), original = truth(bars);
  assert.equal(withNativeSeamEvidence(original, bars, series, now), original);
});

test("native monthly pair uses calendar month boundary, including February", () => {
  const clock = Date.UTC(2026, 2, 5), o = observation();
  o.timeframe = "MN1"; o.collectedAtEpochMs = clock; o.brokerServerTimeEpochMs = clock;
  o.lastClosed.openTimeEpochMs = Date.UTC(2026, 1, 1); o.forming.openTimeEpochMs = Date.UTC(2026, 2, 1);
  assert.equal(recordNativeSeamObservation(o, writer, clock).accepted, true);
  const bars = candles(o), measured = withNativeSeamEvidence(truth(bars, "MN1", clock), bars, series, clock);
  assert.equal(measured.mergeSeam.nativeObservation?.kind, "mt5_shift1_shift0");
  assert.equal(measured.mergeSeam.seamGapIntervals, 0);
});

test("missing/unbound broker quote still earns no symbol-mirror points after native seam observation", () => {
  recordNativeSeamObservation(observation(), writer, now); const bars = candles();
  const measured = withNativeSeamEvidence(truth(bars), bars, series, now);
  const score = computeChartTruthScore(measured, { stale: false, isLive: true, quality: "clean" } as any);
  assert.equal(score.subMetrics.find(m => m.key === "symbol_mirror_accuracy")?.rawScore, null);
  assert.equal(score.subMetrics.find(m => m.key === "historical_live_merge")?.rawScore, 100);
});
