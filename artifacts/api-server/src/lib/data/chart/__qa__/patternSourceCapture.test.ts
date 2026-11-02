import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { currentClosedPatternWindow } from "../closedPatternWindow.js";
import type { RubyChartContext } from "../rubyChartContext.js";

const children: { source?: string | null; timestampConvention?: string; rawCandles: unknown }[] = [];
mock.module("../patternTruthService.js", { namedExports: {
  buildPatternTruthVerdict: (input: typeof children[number]) => { children.push(input); return null; },
  buildPatternLibraryRead: (input: typeof children[number]) => { children.push(input); return null; },
} });
mock.module("../trendlineTruthService.js", { namedExports: {
  buildTrendlineTruthVerdict: (input: typeof children[number]) => { children.push(input); return null; },
} });
const { buildMarketIntelligenceSnapshot } = await import("../marketIntelligenceService.js");
const time = "2024-01-01T12:00:00.000Z";
const candles = [{ time, open: 100, high: 102, low: 99, close: 101 }];
for (const source of ["mt5_broker", "deriv_public", "assistant_real:legacy", null]) {
  test(`intelligence passes captured provider and open-time convention to all three children (${source})`, () => {
    children.length = 0;
    const ctx = {
      timeframe: "M15", basis: "VERIFIED", confidentReadAllowed: true,
      liveDelayed: false, hasFormingCandle: false, closedBarsCount: 200,
      sufficiency: { canShowTradeSetup: true }, feedStatus: { source }, candles,
      htfCandles: [], htfTimeframe: null, htfFeedStatus: null,
      state: {
        symbol: "EURUSD", displaySymbol: "EURUSD", truthState: { source: "unrelated-provider" }, stale: false, assetClass: "forex",
        candleStats: { lastClose: 101, atr: 2, avgRange: 3, body: 1, changeAbs: 1, direction: "up" },
        marketUnderstanding: { trend: { direction: "bullish", higherTimeframeBias: "unknown", regime: "trending", populated: true }, levels: { nearestSupport: null, nearestResistance: null }, candleIntent: { dominantPressure: "balanced", latestIntent: "unknown" } },
        fastFlags: { momentumBurst: false, nearRecentHigh: false, nearRecentLow: false },
        setupState: { direction: "none", hasActiveSetup: false, ageBars: null, expiresInBars: null, invalidationPrice: null, stage: "none" },
        latestClosedCandle: { closeTime: "2024-01-01T12:15:00.000Z" },
      },
    } as unknown as RubyChartContext;
    assert.ok(buildMarketIntelligenceSnapshot(ctx), "actual intelligence composition must complete");
    assert.equal(children.length, 3);
    assert.ok(children.every(input => input.source === source));
    assert.ok(children.every(input => input.timestampConvention === "open"));
    assert.ok(children.every(input => input.rawCandles === candles));
  });
}

test("a captured normalized open time is not shifted again by the original provider convention", () => {
  const input = { symbol: "EURUSD", timeframe: "M15", source: "assistant_real:legacy", rawCandles: candles, timestampConvention: "open" as const };
  const result = currentClosedPatternWindow(input);
  assert.equal(result?.[0]?.openTime, time);
  assert.equal(result?.[0]?.closeTime, "2024-01-01T12:15:00.000Z");
  assert.equal(result?.[0]?.source, input.source);
  assert.notEqual(result?.[0]?.timeBasisEvidence?.kind, "original_utc", "coordinate convention is not UTC authority");
});

test("raw provider timestamps retain the original close-time convention", () => {
  const result = currentClosedPatternWindow({ symbol: "EURUSD", timeframe: "M15", source: "assistant_real:legacy", rawCandles: candles });
  assert.equal(result?.[0]?.openTime, "2024-01-01T11:45:00.000Z");
  assert.equal(result?.[0]?.closeTime, time);
});
