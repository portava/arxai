// The trust line's "Mirror …" segment must agree with the Symbol Mirror
// Accuracy check: when the merge seam could not be checked, a BOUND, aligned
// broker quote opens the trade-confirmation gate, but the mirror check itself
// is "not confirmed", so the line may not say "Mirror synced".
//
// Pure, explicitly synthetic offline evidence. No provider, DB or broker calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandleTruth, type TimeframeTruthResult } from "../candleTruthEngine.js";
import { computeChartTruthScore, isMergeSeamMeasured } from "../chartTruthScore.js";
import { computeChartGateOutput, gateMirrorBlockCause } from "../chartGateOutput.js";
import { buildChartHandshake } from "../chartHandshake.js";
import { computeBrokerPriceAlignment, mirrorTrustSegment } from "../brokerPriceAlignment.js";
import { bindBrokerQuote } from "../brokerQuoteBinding.js";
import type { ChartFeedStatus } from "../chartDataService.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";
import { buildTrustLine } from "../eleanorChartContext.js";
import { buildEleanorDraftRead } from "../../../assistant/eleanorDraftRead.js";
import { recordStateTruthResult, truthResultOfState } from "../stateTruthResult.js";

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
function quoteAlignment(bid: number, ask: number) {
  const binding = bindBrokerQuote({
    series,
    quote: { source: "mt5_live_quote", providerId: "mt5_broker", bridgeConnectionId: 7, userId: 70,
      environment: null, brokerSymbol: null, tickAt: new Date(epoch).toISOString(), bid, ask, spreadPoints: 2 },
    requestingUserId: 70, now: epoch + 1_000,
  });
  return computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
    brokerBid: bid, brokerAsk: ask, spreadPoints: 2, quoteBinding: binding });
}
const read = { score: 100, label: "Highly Readable" as const, subMetrics: [], primaryConcern: null, note: "Offline fixture" };

function draftState(truth: TimeframeTruthResult, gate: ReturnType<typeof computeChartGateOutput>,
  score: ReturnType<typeof computeChartTruthScore>, alignment: ReturnType<typeof quoteAlignment>): ChartIntelligenceState {
  return {
    symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", assetClass: "forex",
    aiUsable: true, stale: false, truthState: feed, currentCandle: null, candleStats: { barsAnalyzed: 199 },
    marketUnderstanding: { populated: false, note: "", readiness: { quality: "unrated", score: null }, levels: { levels: [] } },
    decisionState: { populated: false, bias: "neutral" }, marketSentences: {},
    agentConsensus: { populated: false, note: "", headline: "", stance: "neutral", conflict: false, protective: false, cautions: [] },
    gateOutput: gate, chartTruthScore: score, brokerAlignment: alignment, truthResult: truth,
  } as unknown as ChartIntelligenceState;
}

test("an unchecked merge seam with a bound, aligned broker quote is never 'Mirror synced'", () => {
  const truth = noSeam(), tight = quoteAlignment(1.09999, 1.10001);
  assert.equal(tight.quoteBinding?.status, "BOUND"); assert.equal(tight.tolerance, "tight");
  assert.equal(isMergeSeamMeasured(truth), false);
  const score = computeChartTruthScore(truth, feed, tight);
  const mirror = score.subMetrics.find(m => m.key === "symbol_mirror_accuracy")!;
  assert.equal(mirror.evidenceStatus, "unavailable");
  assert.match(mirror.detail, /Symbol mirror not confirmed/);
  // The gate decision is unchanged: the bound broker comparison alone opens it.
  const gate = computeChartGateOutput(score, read, tight, truth, false);
  assert.equal(gate.tradeConfirmationAllowed, true);
  assert.equal(buildChartHandshake(gate, score).MirrorSync, "WARN");

  const segment = mirrorTrustSegment(gate.tradeConfirmationAllowed, tight, gateMirrorBlockCause(gate, truth));
  assert.equal(segment, "Mirror not confirmed (broker price aligned; seam not checked)");

  const line = buildTrustLine(gate, tight, "M5", false, buildChartHandshake(gate, score).overall,
    { feed, mergeSeamChecked: isMergeSeamMeasured(truth) });
  assert.doesNotMatch(line, /Mirror synced/, line);
  assert.match(line, /Mirror not confirmed \(broker price aligned; seam not checked\)/, line);

  const draft = buildEleanorDraftRead(draftState(truth, gate, score, tight), "analyze").trustLine;
  assert.doesNotMatch(draft, /Mirror synced/, draft);
  assert.match(draft, /Mirror not confirmed \(broker price aligned; seam not checked\)/, draft);
  // A draft state without the truth result cannot show the seam was observed.
  const noTruth = { ...draftState(truth, gate, score, tight), truthResult: null } as unknown as ChartIntelligenceState;
  assert.doesNotMatch(buildEleanorDraftRead(noTruth, "analyze").trustLine, /Mirror synced/);
});

test("a measured seam with a bound, aligned broker quote still reads 'Mirror synced'", () => {
  const truth = fixture(), tight = quoteAlignment(1.09999, 1.10001);
  const score = computeChartTruthScore(truth, feed, tight);
  const gate = computeChartGateOutput(score, read, tight, truth, false);
  assert.equal(gate.tradeConfirmationAllowed, true);
  assert.equal(mirrorTrustSegment(true, tight, gateMirrorBlockCause(gate, truth)), "Mirror synced");
  assert.match(buildTrustLine(gate, tight, "M5", false, "WARN", { feed, mergeSeamChecked: true }), /Mirror synced/);
  assert.match(buildEleanorDraftRead(draftState(truth, gate, score, tight), "analyze").trustLine, /Mirror synced/);
});

test("a built state carries its seam evidence beside it, not as a serialized field", () => {
  const truth = fixture(), tight = quoteAlignment(1.09999, 1.10001);
  const score = computeChartTruthScore(truth, feed, tight);
  const gate = computeChartGateOutput(score, read, tight, truth, false);
  // Production states have no truthResult property (the chart builder never
  // puts it on the state, so API responses never carry it).
  const built = draftState(truth, gate, score, tight) as unknown as Record<string, unknown>;
  delete built.truthResult;
  const state = built as unknown as ChartIntelligenceState;
  assert.equal(JSON.stringify(state).includes("truthResult"), false);
  // Before the builder records the truth result, the seam is unobserved.
  assert.equal(truthResultOfState(state), null);
  assert.doesNotMatch(buildEleanorDraftRead(state, "analyze").trustLine, /Mirror synced/);
  // Once recorded (as buildChartIntelligenceState / enrichStateWithBrokerAlignment
  // do), a measured seam reads "Mirror synced" and stays out of the JSON.
  recordStateTruthResult(state, truth);
  assert.equal(truthResultOfState(state), truth);
  assert.match(buildEleanorDraftRead(state, "analyze").trustLine, /Mirror synced/);
  assert.equal(JSON.stringify(state).includes("truthResult"), false);
});
