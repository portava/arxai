// Chart Truth: an unmeasured check earns no points and is named as "could not
// be checked", never as a degraded/failed/passed result.
//
// Pure, explicitly synthetic offline evidence. No provider, DB or broker calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandleTruth, type TimeframeTruthResult } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput, gateMirrorBlockCause, MIRROR_NOT_CHECKED_REASON } from "../chartGateOutput.js";
import { buildChartHandshake } from "../chartHandshake.js";
import { computeBrokerPriceAlignment, mirrorTrustSegment, noBrokerAlignment } from "../brokerPriceAlignment.js";
import { bindBrokerQuote } from "../brokerQuoteBinding.js";
import type { ChartFeedStatus } from "../chartDataService.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";
import { buildTrustLine, gatedReadReason } from "../rubyChartContext.js";
import { buildRubyDraftRead } from "../../../assistant/rubyDraftRead.js";

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

test("no candles, or no seam and no bound broker comparison, never allows trade confirmation by absence", () => {
  const empty = computeChartTruthScore(null, feed);
  const none = computeChartGateOutput(empty, read, noBrokerAlignment(null, "LAST"), null, false);
  assert.equal(none.tradeConfirmationAllowed, false);
  assert.ok(none.blockedReasons.includes(MIRROR_NOT_CHECKED_REASON));
  assert.doesNotMatch(none.blockedReasons.join(" "), /alignment failed|integrity failed/);
  // Not a failure: the handshake field stays unknown and the trust line says "not checked".
  assert.equal(buildChartHandshake(none, empty).MirrorSync, "WARN");
  assert.equal(mirrorTrustSegment(none.tradeConfirmationAllowed, noBrokerAlignment(null, "LAST"), gateMirrorBlockCause(none)), "Mirror not checked");
  const truth = noSeam(), score = computeChartTruthScore(truth, feed);
  const unchecked = computeChartGateOutput(score, read, noBrokerAlignment(1.1, "MID"), truth, false);
  assert.equal(unchecked.tradeConfirmationAllowed, false);
  assert.ok(unchecked.blockedReasons.includes(MIRROR_NOT_CHECKED_REASON));
  // Either observation alone keeps the previous decision.
  const seamOnly = computeChartGateOutput(computeChartTruthScore(fixture(), feed), read, noBrokerAlignment(1.1, "MID"), fixture(), false);
  assert.equal(seamOnly.tradeConfirmationAllowed, true);
  const tight = quoteAlignment(1.09999, 1.10001);
  const brokerOnly = computeChartGateOutput(computeChartTruthScore(truth, feed, tight), read, tight, truth, false);
  assert.equal(brokerOnly.tradeConfirmationAllowed, true);
  assert.ok(!brokerOnly.blockedReasons.includes(MIRROR_NOT_CHECKED_REASON));
  // An observed seam failure is still "degraded" and FAIL.
  const overlap = fixture({ mergeSeam: { formingBarDetected: true, formingBarCount: 1, gapAtSeam: false, overlapAtSeam: true, seamGapIntervals: 0 } });
  const overlapGate = computeChartGateOutput(computeChartTruthScore(overlap, feed), read, noBrokerAlignment(1.1, "MID"), overlap, false);
  assert.equal(overlapGate.tradeConfirmationAllowed, false);
  assert.equal(mirrorTrustSegment(false, noBrokerAlignment(1.1, "MID"), gateMirrorBlockCause(overlapGate)), "Mirror degraded");
  assert.equal(buildChartHandshake(overlapGate, computeChartTruthScore(overlap, feed)).MirrorSync, "FAIL");
});

test("a failed deviation from another feed's quote or an old tick is named for what it is", () => {
  const truth = fixture();
  for (const [name, alignment, why, short] of [
    ["another feed", quoteAlignment(2, 2.0001, { bridgeConnectionId: 8 }), /from a different feed or account than this chart/, "broker quote is from another feed"],
    ["old tick", quoteAlignment(2, 2.0001, { tickAgeMs: 3 * 86_400_000 }), /from an old broker tick/, "broker tick is old"],
  ] as const) {
    assert.notEqual(alignment.quoteBinding?.status, "BOUND", name); assert.equal(alignment.tolerance, "failed", name);
    const score = computeChartTruthScore(truth, feed, alignment);
    const gate = computeChartGateOutput(score, read, alignment, truth, false);
    // Report only: the gate stays closed exactly as before.
    assert.equal(gate.tradeConfirmationAllowed, false, name);
    const text = gate.blockedReasons.join(" ");
    assert.doesNotMatch(text, /Broker price alignment failed/, name);
    assert.match(text, why, name);
    assert.match(text, /does not show whether this chart matches your broker/, name);
    assert.equal(mirrorTrustSegment(gate.tradeConfirmationAllowed, alignment, gateMirrorBlockCause(gate)), `Mirror not confirmed (${short})`, name);
  }
  // A BOUND failed comparison is still "alignment failed" / "Mirror degraded".
  const bound = quoteAlignment(2, 2.0001);
  const boundGate = computeChartGateOutput(computeChartTruthScore(truth, feed, bound), read, bound, truth, false);
  assert.ok(boundGate.blockedReasons.includes("Broker price alignment failed — chart-based trade confirmation blocked."));
  assert.equal(mirrorTrustSegment(false, bound, gateMirrorBlockCause(boundGate)), "Mirror degraded");
  // An observed seam failure alongside an unbound quote still reads "degraded".
  const overlap = fixture({ mergeSeam: { formingBarDetected: true, formingBarCount: 1, gapAtSeam: false, overlapAtSeam: true, seamGapIntervals: 0 } });
  const other = quoteAlignment(2, 2.0001, { bridgeConnectionId: 8 });
  const both = computeChartGateOutput(computeChartTruthScore(overlap, feed, other), read, other, overlap, false);
  assert.equal(mirrorTrustSegment(false, other, gateMirrorBlockCause(both)), "Mirror degraded");
});

test("trust lines say Verified only in the Verified band, Live feed only for a confirmed-live feed, and what the AACI warning means", () => {
  const truth = fixture(), tight = quoteAlignment(1.09999, 1.10001);
  const score = computeChartTruthScore(truth, feed, tight);
  assert.equal(score.label, "Healthy");
  const gate = computeChartGateOutput(score, read, tight, truth, false);
  assert.equal(gate.confidentReadAllowed, true);
  const handshake = buildChartHandshake(gate, score);
  assert.equal(handshake.overall, "WARN"); assert.equal(handshake.sourceOverall, "PASS");
  assert.equal(buildTrustLine(gate, tight, "M5", false, handshake.overall, { feed, aaciSourceOverall: handshake.sourceOverall }),
    `M5 candles: Chart Truth ${score.score} (Healthy) · Live feed · Mirror synced · AACI candle checks pass · chart rendering not measured`);
  // Without feed evidence the line cannot claim "Live feed" or "Verified".
  const bare = buildTrustLine(gate, tight, "M5", false, "WARN");
  assert.doesNotMatch(bare, /Verified|Live feed|^AACI warning$/);
  assert.match(bare, /Feed not confirmed live/); assert.match(bare, /AACI warning: some checks not confirmed/);
  const feedCases: Array<[ChartFeedStatus, string]> = [
    [{ ...feed, quality: "delayed", aiUsable: false }, "Feed delayed"],
    [{ ...feed, isLive: false }, "Feed not live"],
  ];
  for (const [status, expected] of feedCases) {
    const s = computeChartTruthScore(truth, status, tight);
    const g = computeChartGateOutput(s, read, tight, truth, status.stale);
    assert.equal(g.autonomousChartActionAllowed, true);
    const line = buildTrustLine(g, tight, "M5", false, buildChartHandshake(g, s).overall, { feed: status });
    assert.doesNotMatch(line, /Live feed|Verified/, line); assert.match(line, new RegExp(expected), line);
    // Ruby's draft-read footer is built from the same segments.
    const state = {
      symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", assetClass: "forex",
      aiUsable: false, stale: false, truthState: status, currentCandle: null, candleStats: { barsAnalyzed: 199 },
      marketUnderstanding: { populated: false, note: "", readiness: { quality: "unrated", score: null }, levels: { levels: [] } },
      decisionState: { populated: false, bias: "neutral" }, marketSentences: {},
      agentConsensus: { populated: false, note: "", headline: "", stance: "neutral", conflict: false, protective: false, cautions: [] },
      gateOutput: g, chartTruthScore: s, brokerAlignment: tight,
    } as unknown as ChartIntelligenceState;
    const draft = buildRubyDraftRead(state, "analyze").trustLine;
    assert.doesNotMatch(draft, /Live feed|Verified/, draft); assert.match(draft, new RegExp(expected), draft);
  }
});

// Review (truth port, S02): Ruby's basis keeps the full handshake rollup, so
// with every candle check passing the only open check is chart rendering,
// which the server never measures. The refusal named nothing ("Not every
// chart check has passed") while the trust line said the candle checks pass.
test("a gated Ruby read with only chart rendering open names it, never a bare 'not every check'", () => {
  const truth = fixture(), tight = quoteAlignment(1.09999, 1.10001);
  const score = computeChartTruthScore(truth, feed, tight);
  const gate = computeChartGateOutput(score, read, tight, truth, false);
  assert.equal(gate.confidentReadAllowed, true);
  assert.equal(gate.autonomousChartActionAllowed, true);
  assert.equal(gate.tradeConfirmationAllowed, true);
  const handshake = buildChartHandshake(gate, score);
  assert.equal(handshake.sourceOverall, "PASS"); assert.equal(handshake.RenderHealth, "WARN");
  const state = { stale: false, aiUsable: true, truthState: feed, chartTruthScore: score } as unknown as ChartIntelligenceState;
  const why = gatedReadReason({ basis: "PARTIAL", blockReason: null, gateOutput: gate, state });
  assert.equal(why, "Not every chart check has passed: chart rendering is not measured. I won't draw a tradeable setup until they do.");
  // A measured renderer that failed is named as a failure.
  const failedRender = { ...score, subMetrics: score.subMetrics.map(m => m.key === "render_accuracy"
    ? { ...m, rawScore: 20, evidenceStatus: "measured" as const } : m) };
  const failedWhy = gatedReadReason({ basis: "PARTIAL", blockReason: null, gateOutput: gate,
    state: { ...state, chartTruthScore: failedRender } as unknown as ChartIntelligenceState });
  assert.match(failedWhy ?? "", /chart rendering failed its check/);
});

test("a measured deduction scoring 90-99 is named, never 'No measured check found a problem'", () => {
  // Seam observed, no broker comparison (mirror unmeasured), 10 of 200 bars
  // off the expected precision: the only measured deduction is Price
  // Precision 95, and it is what puts the score under 75.
  const truth = fixture({ precisionViolationCount: 10 });
  const score = computeChartTruthScore(truth, feed);
  const precision = metric(score, "price_precision");
  assert.equal(precision.evidenceStatus, "measured"); assert.equal(precision.rawScore, 95);
  assert.ok(score.score < 75, String(score.score));
  for (const m of score.subMetrics.filter(m => m.evidenceStatus === "measured" && m.key !== "price_precision")) {
    assert.equal(m.rawScore, 100, m.key);
  }
  const reason = computeChartGateOutput(score, read, noBrokerAlignment(1.1, "MID"), truth, false).blockedReasons[0];
  assert.doesNotMatch(reason, /No measured check found a problem/, reason);
  assert.match(reason, new RegExp(`^Chart Truth Score ${score.score} < 75 — chart-based confirmation blocked\\. No measured check scored below 90\\.`), reason);
  assert.match(reason, /Minor measured deductions: Price Precision 95\/100 \(10 precision violation\(s\) out of 200 bars/, reason);
  assert.match(reason, /Could not be checked \(earn no points\): Symbol Mirror Accuracy, Render Accuracy, Scale Quality, Interaction Stability\.$/, reason);
  // A concern under 90 still leads, and a 90-99 deduction is listed after it.
  const both = fixture({ precisionViolationCount: 10, mockDataDetected: true });
  const bothScore = computeChartTruthScore(both, feed);
  const bothReason = computeChartGateOutput(bothScore, read, noBrokerAlignment(1.1, "MID"), both, false).blockedReasons[0];
  assert.match(bothReason, /Measured concerns: Source Authenticity 0\/100\. Minor measured deductions: Price Precision 95\/100 \(/, bothReason);
  assert.doesNotMatch(bothReason, /No measured check/, bothReason);
});

test("an unchecked seam earns no credit inside a measured broker failure", () => {
  const failed = quoteAlignment(2, 2.0001);
  assert.equal(failed.quoteBinding?.status, "BOUND"); assert.equal(failed.tolerance, "failed");
  const observed = metric(computeChartTruthScore(fixture(), feed, failed), "symbol_mirror_accuracy");
  const unchecked = metric(computeChartTruthScore(noSeam(), feed, failed), "symbol_mirror_accuracy");
  assert.equal(observed.evidenceStatus, "measured"); assert.equal(observed.rawScore, 49);
  assert.equal(unchecked.evidenceStatus, "measured");
  // Only the observed broker half is scored, at half weight: (100 - 40) / 2.
  assert.equal(unchecked.rawScore, 30, unchecked.detail);
  assert.ok(unchecked.rawScore! < observed.rawScore!, "an unobserved seam may not score like an observed clean seam");
  assert.ok(unchecked.rawScore! <= 40, "never above the old 80-placeholder value");
  assert.match(unchecked.detail, /Merge seam could not be checked/);
  assert.match(unchecked.detail, /only the broker comparison is scored/i);
  // Without real OHLC the unobserved seam still earns nothing: (75 - 40) / 2.
  const lineOnly = metric(computeChartTruthScore(fixture({ providerDeliversRealOhlc: false,
    mergeSeam: { formingBarDetected: false, formingBarCount: 0, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 } }),
  feed, failed), "symbol_mirror_accuracy");
  assert.equal(lineOnly.rawScore, 17.5);
  // The handshake reading is unchanged: still a FAIL.
  const truth = noSeam(), score = computeChartTruthScore(truth, feed, failed);
  assert.equal(buildChartHandshake(computeChartGateOutput(score, read, failed, truth, false), score).BrokerPriceAlignment, "FAIL");
});

test("an unscored comparison with an unchecked seam never claims to be scored", () => {
  for (const alignment of [quoteAlignment(1.09999, 1.10001), quoteAlignment(2, 2.0001, { bridgeConnectionId: 8 })]) {
    const mirror = metric(computeChartTruthScore(noSeam(), feed, alignment), "symbol_mirror_accuracy");
    assert.equal(mirror.rawScore, null, mirror.detail);
    assert.doesNotMatch(mirror.detail, /is scored/i, mirror.detail);
  }
});
