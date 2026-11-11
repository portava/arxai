import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { recordNativeSeamObservation } from "../nativeSeamObservation.js";
import { foldFormingTick } from "../formingBarComposer.js";
const now = Date.UTC(2026, 10, 5, 18, 4, 30), open = Date.UTC(2026, 10, 5, 18);
const bars = Array.from({ length: 200 }, (_, i) => ({ time: new Date(open - (200-i)*300_000).toISOString(),
  brokerSymbol: "EURUSD.native", open: 1.1, high: 1.12, low: 1.09, close: 1.11, volume: 10 }));
let subProviderId: string | null = null;
const realRouter = await import("../../marketDataRouter.js");
mock.module("../../marketDataRouter.js", { namedExports: { ...realRouter,
  routeCandles: async () => ({ ok: true, symbol: "EURUSD", timeframe: "M5", assetClass: "forex", candles: bars,
    primaryProvider: "mt5_broker", provenance: { providerId: "mt5_broker", subProviderId, bridgeConnectionId: 7,
      userId: 70, brokerSymbol: "EURUSD.native", environment: "unknown", source: "BROKER", delayed: false },
    provenanceNotes: [], attempts: [], userMessage: null }),
} });
const realSession = await import("../sessionProfile.js");
mock.module("../sessionProfile.js", { namedExports: { ...realSession, getSessionProfile: async () => null } });
mock.module("../../candleCache.js", { namedExports: {
  readCachedCandles: async () => ({ candles: bars, count: bars.length, oldest: bars[0]?.time, newest: bars.at(-1)?.time, hasOlderInCache: false }),
  getCacheCoverage: async () => ({ oldest: bars[0]?.time, newest: bars.at(-1)?.time }), listCachedSources: async () => [],
  upsertCandles: async () => {}, isValidCacheOhlc: () => true,
} });
const { getChartCandles } = await import("../chartDataService.js");

test("real chart feed attaches native seam metadata without adding forming analytical candles", async () => {
  mock.timers.enable({ apis: ["Date"], now });
  try {
    const before = await getChartCandles("EURUSD", "M5", 200);
    assert.equal(before.truthResult?.mergeSeam.formingBarDetected, false);
    foldFormingTick("EURUSD", 500, now, now, "mt5_broker");
    const noNative = await getChartCandles("EURUSD", "M5", 200, true);
    assert.equal(noNative.candles.some(c => c.isForming), false, "a sampled tick cannot invent a native MT5 candle");
    assert.equal(recordNativeSeamObservation({ symbol: "EURUSD", brokerSymbol: "EURUSD.native", timeframe: "M5",
      collectedAtEpochMs: now, brokerServerTimeEpochMs: now, brokerUtcOffsetMs: 0,
      lastClosed: { openTimeEpochMs: open - 300_000, open: 1.1, high: 1.12, low: 1.09, close: 1.11 },
      forming: { openTimeEpochMs: open, open: 99, high: 100, low: 98, close: 99 },
    }, { bridgeConnectionId: 7, userId: 70 }, now).accepted, true);
    const after = await getChartCandles("EURUSD", "M5", 200);
    assert.equal(after.truthResult?.mergeSeam.nativeObservation?.kind, "mt5_shift1_shift0");
    assert.deepEqual(after.candles, before.candles);
    assert.deepEqual(after.marketEvidence, before.marketEvidence);
    assert.equal(after.candleCount, 200);
    assert.equal(after.candles.some(c => c.isForming), false);
    const display = await getChartCandles("EURUSD", "M5", 200, true), tip = display.candles.at(-1)!;
    assert.deepEqual(display.candles.slice(0, -1), after.candles);
    assert.deepEqual([tip.open, tip.high, tip.low, tip.close], [99, 100, 98, 99], "native snapshot wins over poisoned composer");
    assert.equal(tip.isForming, true); assert.equal(tip.isFinal, false);
    assert.equal(tip.observedAt, new Date(now).toISOString());
    assert.equal(tip.formingOrigin, "native_mt5_snapshot");
    assert.equal(tip.tickVolume, null); assert.equal(tip.volumeEvidence?.kind, "unavailable");
    assert.deepEqual(display.truthResult, after.truthResult, "display native OHLC never changes analysis truth");
    subProviderId = "durable_mirror";
    const stored = await getChartCandles("EURUSD", "M5", 200);
    assert.equal(stored.truthResult?.mergeSeam.nativeObservation, undefined);
    assert.equal(stored.aiUsable, false);
  } finally { mock.timers.reset(); }
});
