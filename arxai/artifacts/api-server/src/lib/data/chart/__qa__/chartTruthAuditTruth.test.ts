// Chart Truth Health audit rows: a check that did not run is "not checked",
// never a tick; CLEAN needs a feed confirmed live; a failed probe keeps the
// symbol's real asset class.
//
// getChartCandles is mocked (no provider, DB, broker or network).
import assert from "node:assert/strict";
import { mock, test } from "node:test";

type Resp = Record<string, unknown>;
let respond: (symbol: string, timeframe: string) => Resp | Promise<Resp>;
mock.module("../chartDataService.js", {
  namedExports: { getChartCandles: async (symbol: string, timeframe: string) => respond(symbol, timeframe) },
});
const { getChartTruthAudit } = await import("../chartTruthAuditService.js");

function clean(symbol: string, timeframe: string, over: { isLive?: boolean; forming?: boolean; precision?: number | null } = {}): Resp {
  const forming = over.forming ?? false;
  return {
    symbol, displaySymbol: symbol, timeframe, assetClass: "forex", source: "twelve_data", quality: "clean", aiUsable: true,
    warning: null, latencyMs: 10, requestedLimit: 10, candleCount: 10, candles: [],
    feedStatus: { isLive: over.isLive ?? true, stale: false, quality: "clean", aiUsable: true },
    truthResult: {
      candleCount: 10, invalidOhlcCount: 0, missingCandleCount: 0, outOfOrderCount: 0, duplicateCount: 0,
      precisionViolationCount: 0, pricePrecision: over.precision === undefined ? 5 : over.precision,
      mockDataDetected: false, assessment: "PARTIAL", formingCandlePresent: forming,
      mergeSeam: { formingBarDetected: forming, formingBarCount: forming ? 1 : 0, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 },
      outlierSpikeCount: 0, outlierWickCount: 0, historicalPeriodShiftCount: 0, mockDataAdminReason: null, newestBarTime: null,
    },
  };
}
const row = (r: Awaited<ReturnType<typeof getChartTruthAudit>>, symbol: string) => {
  const found = r.rows.find(x => x.symbol === symbol && x.timeframe === "M5"); assert.ok(found); return found;
};

test("unmeasured seam / unknown precision are not ticks, and a not-live feed is not CLEAN", async () => {
  respond = (symbol, tf) => clean(symbol, tf, { forming: false, precision: null, isLive: false });
  const report = await getChartTruthAudit(true);
  const r = row(report, "EURUSD");
  assert.equal(r.mergePass, false); assert.equal(r.mergeChecked, false);
  assert.equal(r.priceAlignPass, false); assert.equal(r.priceChecked, false);
  assert.notEqual(r.status, "CLEAN");
  assert.match(r.reasons.join(" "), /not confirmed live/);
  assert.match(r.reasons.join(" "), /Merge seam not checked/);
  assert.match(r.reasons.join(" "), /Price scale not checked/);
  // Not a measured seam failure: no "gap/overlap" claim.
  assert.doesNotMatch(r.reasons.join(" "), /Seam gap\/overlap/);
});

test("measured clean seam and precision on a live feed stay CLEAN with ticks", async () => {
  respond = (symbol, tf) => clean(symbol, tf, { forming: true, precision: 5, isLive: true });
  const r = row(await getChartTruthAudit(true), "EURUSD");
  assert.equal(r.status, "CLEAN");
  assert.equal(r.mergePass, true); assert.equal(r.mergeChecked, true);
  assert.equal(r.priceAlignPass, true); assert.equal(r.priceChecked, true);
});

test("a probe that throws keeps the symbol's real asset class and says it could not be loaded", async () => {
  respond = (symbol, tf) => { if (symbol === "V75") throw new Error("deriv down"); return clean(symbol, tf); };
  const r = row(await getChartTruthAudit(true), "V75");
  assert.equal(r.status, "UNAVAILABLE");
  assert.equal(r.assetClass, "synthetic");
  assert.match(r.reasons.join(" "), /could not be loaded/);
});
