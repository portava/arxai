// Chart Truth: an unmeasured check earns no points and is named as "could not
// be checked", never as a degraded/failed/passed result.
//
// Pure, explicitly synthetic offline evidence. No provider, DB or broker calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandleTruth, type TimeframeTruthResult } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput } from "../chartGateOutput.js";
import { buildChartHandshake } from "../chartHandshake.js";
import { computeBrokerPriceAlignment } from "../brokerPriceAlignment.js";
import { bindBrokerQuote } from "../brokerQuoteBinding.js";
import type { ChartFeedStatus } from "../chartDataService.js";

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
const noSeam = () => fixture({ mergeSeam: { formingBarDetected: false, formingBarCount: 0, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 } });
const feed: ChartFeedStatus = { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", assetClass: "forex",
  source: "dev", isLive: true, lastTickTime: null, lastCandleTime: new Date(epoch).toISOString(), latencyMs: null,
  missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 0,
  stale: false, quality: "clean", warning: null, aiUsable: true, feedReadinessState: null, message: "Offline fixture",
  completenessReason: null };
const series = { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 7, userId: 70, environment: "unknown" as const, brokerSymbol: null };
function quoteAlignment(bid: number, ask: number, over: { bridgeConnectionId?: number; tickAgeMs?: number } = {}) {
  const binding = bindBrokerQuote({
    series,
    quote: { source: "mt5_live_quote", providerId: "mt5_broker", bridgeConnectionId: over.bridgeConnectionId ?? 7, userId: 70,
      environment: null, brokerSymbol: null, tickAt: new Date(epoch).toISOString(), bid, ask, spreadPoints: 2 },
    requestingUserId: 70, now: epoch + (over.tickAgeMs ?? 1_000),
  });
  return computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
    brokerBid: bid, brokerAsk: ask, spreadPoints: 2, quoteBinding: binding });
}
const read = { score: 100, label: "Highly Readable" as const, subMetrics: [], primaryConcern: null, note: "Offline fixture" };
function metric(score: ReturnType<typeof computeChartTruthScore>, key: string) {
  const value = score.subMetrics.find(m => m.key === key); assert.ok(value); return value;
}

test("an unmeasured merge seam earns no placeholder points in the symbol-mirror check", () => {
  const tight = quoteAlignment(1.09999, 1.10001);
  assert.equal(tight.quoteBinding?.status, "BOUND"); assert.equal(tight.tolerance, "tight");
  const score = computeChartTruthScore(noSeam(), feed, tight);
  const mirror = metric(score, "symbol_mirror_accuracy");
  assert.equal(mirror.rawScore, null, mirror.detail);
  assert.equal(mirror.evidenceStatus, "unavailable");
  assert.doesNotMatch(mirror.detail, /seam not assessable\.?$/);
  assert.match(mirror.detail, /merge seam could not be checked/i);
  assert.match(mirror.detail, /broker price aligned \(tight\)/i);
  assert.equal(metric(score, "historical_live_merge").rawScore, null);
  assert.equal(score.score, 65);
  // An observed broker FAILURE stays a measured failure even when the seam
  // could not be checked: it is never hidden as "unmeasured".
  const failed = quoteAlignment(2, 2.0001);
  assert.equal(failed.tolerance, "failed");
  const failedScore = computeChartTruthScore(noSeam(), feed, failed);
  const failedMirror = metric(failedScore, "symbol_mirror_accuracy");
  assert.equal(failedMirror.evidenceStatus, "measured");
  assert.ok(failedMirror.rawScore! < 50);
  const gate = computeChartGateOutput(failedScore, read, failed, noSeam(), false);
  assert.equal(buildChartHandshake(gate, failedScore).BrokerPriceAlignment, "FAIL");
  // A measured seam keeps the combined check exactly as before.
  assert.equal(metric(computeChartTruthScore(fixture(), feed, tight), "symbol_mirror_accuracy").rawScore, 100);
});

test("a score under 75 only because checks could not run is not called Degraded", () => {
  const truth = noSeam();
  const score = computeChartTruthScore(truth, feed);
  assert.equal(score.score, 65); assert.equal(score.label, "Degraded");
  for (const m of score.subMetrics.filter(m => m.evidenceStatus === "measured")) assert.equal(m.rawScore, 100, m.key);
  const gate = computeChartGateOutput(score, read, quoteAlignment(NaN, NaN), truth, false);
  const reason = gate.blockedReasons[0];
  assert.doesNotMatch(reason, /Degraded/);
  assert.match(reason, /^Chart Truth Score 65 < 75 — chart-based confirmation blocked\. No measured check found a problem\./);
  assert.match(reason, /Could not be checked \(earn no points\): Symbol Mirror Accuracy, Historical\/Live Merge Quality, Render Accuracy, Scale Quality, Interaction Stability\.$/);
  assert.equal(gate.primaryBlockReason, reason);
  // A measured concern still names the band and the concern itself.
  const mock = fixture({ mockDataDetected: true });
  const mockScore = computeChartTruthScore(mock, feed, quoteAlignment(1.09999, 1.10001));
  assert.equal(mockScore.label, "Degraded");
  const mockReason = computeChartGateOutput(mockScore, read, quoteAlignment(1.09999, 1.10001), mock, false).blockedReasons[0];
  assert.match(mockReason, /^Chart Truth Score 72 < 75 \(Degraded\) — chart-based confirmation blocked\. Measured concerns: Source Authenticity 0\/100\./);
  assert.match(mockReason, /Could not be checked \(earn no points\): Render Accuracy, Scale Quality, Interaction Stability\.$/);
});
