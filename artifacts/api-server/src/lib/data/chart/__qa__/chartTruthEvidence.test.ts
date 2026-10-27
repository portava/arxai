import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandleTruth, type TimeframeTruthResult } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput } from "../chartGateOutput.js";
import { buildChartHandshake } from "../chartHandshake.js";
import { computeBrokerPriceAlignment, noBrokerAlignment } from "../brokerPriceAlignment.js";
import type { ChartFeedStatus } from "../chartDataService.js";
import { GetChartCandlesResponse } from "@workspace/api-zod";

// Pure, explicitly synthetic offline evidence. No provider, DB or broker calls.
const epoch = 1_700_000_000_000;
function fixture(overrides: Partial<TimeframeTruthResult> = {}): TimeframeTruthResult {
  const result = runCandleTruth(Array.from({ length: 200 }, (_, i) => ({
    time: new Date(epoch + i * 300_000).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1,
  })), { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", source: "dev",
    assetClass: "forex", limit: 200, now: epoch + 199 * 300_000 + 60_000 }).truthResult;
  return { ...result, assessment: "CLEAN", assessmentReasons: [], sourceMode: "live",
    providerDeliversRealOhlc: true, mockDataDetected: false, pricePrecision: 5,
    mergeSeam: { formingBarDetected: true, formingBarCount: 1, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 },
    ...overrides };
}
const feed: ChartFeedStatus = { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", assetClass: "forex",
  source: "dev", isLive: true, lastTickTime: null, lastCandleTime: new Date(epoch).toISOString(), latencyMs: null,
  missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 0,
  stale: false, quality: "clean", warning: null, aiUsable: true, feedReadinessState: null, message: "Offline fixture",
  completenessReason: null };
const alignment = computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
  brokerBid: 1.09999, brokerAsk: 1.10001, spreadPoints: 2 });
const read = { score: 100, label: "Highly Readable" as const, subMetrics: [], primaryConcern: null, note: "Offline fixture" };
function metric(score: ReturnType<typeof computeChartTruthScore>, key: string) {
  const value = score.subMetrics.find(m => m.key === key); assert.ok(value); return value;
}

test("good source bars cannot fabricate renderer, scale or interaction evidence", () => {
  const score = computeChartTruthScore(fixture(), feed, alignment);
  for (const key of ["render_accuracy", "scale_quality", "interaction_stability"]) {
    assert.deepEqual({ raw: metric(score, key).rawScore, weighted: metric(score, key).weightedScore,
      evidence: metric(score, key).evidenceStatus }, { raw: null, weighted: null, evidence: "unavailable" });
  }
  assert.equal(score.score, 87); assert.equal(score.evidenceCoverage, .87);
  assert.notEqual(score.label, "Verified"); assert.match(score.note, /incomplete verification/);
  assert.equal(score.unmeasuredKeys.length, 3);
});
test("missing feed earns zero and no placeholder manufactures points", () => {
  const score = computeChartTruthScore(null, feed);
  assert.equal(score.score, 0); assert.equal(score.label, "Read-blocked");
  assert.equal(metric(score, "interaction_stability").rawScore, null);
  assert.equal(metric(score, "feed_freshness").rawScore, 0);
  assert.equal(score.evidenceCoverage, .09);
});
for (const candleCount of [0, -1, NaN, Infinity]) test(`invalid empty count ${candleCount} cannot earn points`, () => {
  assert.equal(computeChartTruthScore(fixture({ candleCount }), feed, alignment).score, 0);
});
test("missing expected precision is unknown, not a perfect precision result", () => {
  const score = computeChartTruthScore(fixture({ pricePrecision: null }), feed, alignment);
  assert.equal(metric(score, "price_precision").rawScore, null);
  assert.equal(score.score, 79); assert.equal(score.evidenceCoverage, .79);
});
test("unconfirmed source mode earns no authenticity points", () => {
  const score = computeChartTruthScore(fixture({ sourceMode: "unknown" }), feed, alignment);
  assert.equal(metric(score, "source_authenticity").rawScore, null);
  assert.equal(score.evidenceCoverage, .72); assert.equal(score.score, 72);
});
test("no broker comparison or no merge boundary does not prove either dimension", () => {
  const truth = fixture(); truth.mergeSeam.formingBarDetected = false;
  const score = computeChartTruthScore(truth, feed);
  assert.equal(metric(score, "symbol_mirror_accuracy").rawScore, null);
  assert.equal(metric(score, "historical_live_merge").rawScore, null);
  assert.equal(score.score, 65); assert.equal(score.evidenceCoverage, .65);
  const gate = computeChartGateOutput(score, read, noBrokerAlignment(null, "UNKNOWN"), truth, false);
  assert.equal(gate.confidentReadAllowed, false); assert.equal(gate.scannerConfirmAllowed, false);
  assert.equal(gate.selfTradeChartAllowed, false);
  assert.equal(gate.candlestickModeAllowed, true); // rendering is not blocked
});
test("actual all-forming source has no measured historical-to-live boundary", () => {
  const truth = runCandleTruth([{ time: new Date(epoch).toISOString(), open: 1, high: 1.1, low: .9, close: 1 }],
    { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", source: "dev", assetClass: "forex",
      limit: 1, now: epoch + 60_000 }).truthResult;
  assert.equal(truth.mergeSeam.formingBarDetected, true);
  assert.equal(metric(computeChartTruthScore(truth, feed, alignment), "historical_live_merge").rawScore, null);
});
for (const [bid, ask] of [[0, 0], [-1, 1], [NaN, 1], [1, Infinity], [2, 1]] as const)
  test(`unusable actual broker quote ${bid}/${ask} cannot become measured alignment`, () => {
    const invalid = computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
      brokerBid: bid, brokerAsk: ask, spreadPoints: 0 });
    assert.equal(invalid.brokerDataAvailable, false); assert.equal(invalid.aligned, false);
    assert.equal(invalid.tolerance, "unknown");
    assert.equal(metric(computeChartTruthScore(fixture(), feed, invalid), "symbol_mirror_accuracy").rawScore, null);
    const fabricated = { ...alignment, brokerBid: bid, brokerAsk: ask };
    assert.equal(metric(computeChartTruthScore(fixture(), feed, fabricated), "symbol_mirror_accuracy").rawScore, null);
  });
test("nonfinite chart price cannot become measured alignment", () => {
  const invalid = computeBrokerPriceAlignment({ chartPrice: Infinity, chartPriceBasis: "MID", assetClass: "forex",
    brokerBid: 1, brokerAsk: 1.1, spreadPoints: 0 });
  assert.equal(invalid.brokerDataAvailable, false); assert.equal(invalid.aligned, false);
});
test("contradictory clean quality never overrides stale or non-live evidence", () => {
  assert.equal(metric(computeChartTruthScore(fixture(), { ...feed, stale: true }, alignment), "feed_freshness").rawScore, 35);
  assert.equal(metric(computeChartTruthScore(fixture(), { ...feed, isLive: false }, alignment), "feed_freshness").rawScore, 70);
  assert.equal(metric(computeChartTruthScore(fixture(), { ...feed, quality: "invalid", stale: true }, alignment), "feed_freshness").rawScore, 10);
});
test("known source and seam failures remain measured failures", () => {
  const truth = fixture({ mockDataDetected: true }); truth.mergeSeam.overlapAtSeam = true;
  const score = computeChartTruthScore(truth, feed, alignment);
  assert.equal(metric(score, "source_authenticity").rawScore, 0);
  assert.equal(metric(score, "historical_live_merge").rawScore, 50);
  const gate = computeChartGateOutput(score, read, alignment, truth, false);
  assert.equal(gate.tradeConfirmationAllowed, false);
  assert.equal(buildChartHandshake(gate, score).MirrorSync, "FAIL");
});
test("a measured failed broker comparison remains FAIL in its named handshake field", () => {
  const failed = computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
    brokerBid: 2, brokerAsk: 2.0001, spreadPoints: 1 });
  assert.equal(failed.tolerance, "failed");
  const truth = fixture(), score = computeChartTruthScore(truth, feed, failed);
  const gate = computeChartGateOutput(score, read, failed, truth, false);
  assert.equal(buildChartHandshake(gate, score).BrokerPriceAlignment, "FAIL");
  assert.equal(buildChartHandshake(gate, score).overall, "FAIL");
});
test("handshake cannot turn unmeasured rendering into PASS from clean aggregate gates", () => {
  const truth = fixture(), score = computeChartTruthScore(truth, feed, alignment);
  const gate = computeChartGateOutput(score, read, alignment, truth, false);
  assert.equal(gate.confidentReadAllowed, true);
  const result = buildChartHandshake(gate, score);
  assert.equal(result.OHLCIntegrity, "PASS"); assert.equal(result.BrokerPriceAlignment, "PASS");
  assert.equal(result.RenderHealth, "WARN"); assert.equal(result.overall, "WARN");
  assert.match(result.primaryBlockReason!, /Not measured/);
  const absent = buildChartHandshake(gate);
  for (const key of ["RenderHealth", "BrokerPriceAlignment", "HistoricalLiveMerge", "MirrorSync", "OHLCIntegrity", "FeedFreshness"] as const)
    assert.equal(absent[key], "WARN");
});
test("legacy cached perfect sub-scores without evidence status remain unknown", () => {
  const truth = fixture(), score = computeChartTruthScore(truth, feed, alignment);
  const gate = computeChartGateOutput(score, read, alignment, truth, false);
  const legacy = JSON.parse(JSON.stringify(score));
  for (const m of legacy.subMetrics) { delete m.evidenceStatus; m.rawScore = 100; }
  assert.equal(buildChartHandshake(gate, legacy).RenderHealth, "WARN");
  assert.equal(buildChartHandshake(gate, legacy).BrokerPriceAlignment, "WARN");
});
test("JSON roundtrip preserves nulls, measured coverage and finite fixed-weight lower bound", () => {
  for (const missing of [false, true]) {
    const score = computeChartTruthScore(fixture({ pricePrecision: missing ? null : 5 }), feed, missing ? undefined : alignment);
    const decoded = JSON.parse(JSON.stringify(score));
    assert.deepEqual(decoded, score);
    assert.deepEqual(GetChartCandlesResponse.shape.chartTruthScore.parse(decoded), score);
    assert.equal(score.score, Math.round(score.subMetrics.reduce((sum, m) => sum + (m.weightedScore ?? 0), 0) * 100) / 100);
    assert.ok(score.score <= score.evidenceCoverage * 100 + .001);
    assert.equal(Math.round(score.subMetrics.reduce((sum, m) => sum + m.weight, 0) * 100), 100);
  }
});
