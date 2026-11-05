// An A-grade setup on an unverified chart read must not say "Ready" or
// "act with a defined stop" (truth upgrade, 2026-10-28).
//
// Readiness is graded from the candle engines, which only check aiUsable and
// staleness. The chart-truth gate is a stricter, separate verdict (Chart Truth
// ≥ 75, feed not stale, mirror not failed); for a user without a bound broker
// quote it is usually closed. Eleanor already answers "Chart data is syncing…"
// for that state, so the decision summary and the best-action sentence must
// not invite action on the same read. Offline: no provider, DB or broker calls.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCandleTruth, type TimeframeTruthResult } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput, type ChartGateOutput } from "../chartGateOutput.js";
import { computeBrokerPriceAlignment, noBrokerAlignment } from "../brokerPriceAlignment.js";
import { bindBrokerQuote } from "../brokerQuoteBinding.js";
import type { ChartFeedStatus } from "../chartDataService.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";
import { buildMarketSentences } from "../marketSentenceEngine.js";
import { capDecisionStateByChartTruth, chartReadVerification } from "../chartDecisionTruthCap.js";

const epoch = 1_700_000_000_000;
function truthFixture(overrides: Partial<TimeframeTruthResult> = {}): TimeframeTruthResult {
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
const read = { score: 100, label: "Highly Readable" as const, subMetrics: [], primaryConcern: null, note: "Offline fixture" };

/** Alignment from a bound, matching broker quote (every candle-data check measured). */
function boundAlignment() {
  const quoteBinding = bindBrokerQuote({
    series: { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 7, userId: 70, environment: "unknown", brokerSymbol: null },
    quote: { source: "mt5_live_quote", providerId: "mt5_broker", bridgeConnectionId: 7, userId: 70, environment: null, brokerSymbol: null,
      tickAt: new Date(epoch).toISOString(), bid: 1.09999, ask: 1.10001, spreadPoints: 2 },
    requestingUserId: 70, now: epoch + 1_000,
  });
  return computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex" as const,
    brokerBid: 1.09999, brokerAsk: 1.10001, spreadPoints: 2, quoteBinding });
}
function boundScore(truth: TimeframeTruthResult = truthFixture()) {
  return computeChartTruthScore(truth, feed, boundAlignment());
}
/**
 * The same score with the chart-rendering check MEASURED and passing. The
 * server never measures rendering (client telemetry), so computeChartTruthScore
 * leaves it unmeasured and Eleanor's VERIFIED basis (the full handshake rollup,
 * RenderHealth included) is out of reach; the verified path is pinned with
 * renderer evidence supplied here.
 */
function withMeasuredRender<T extends ReturnType<typeof boundScore>>(score: T): T {
  return { ...score, subMetrics: score.subMetrics.map((m) => m.key === "render_accuracy"
    ? { ...m, rawScore: 100, evidenceStatus: "measured" as const, detail: "Renderer telemetry fixture." }
    : m) };
}

function gate(truthScore: number, over: Partial<ChartGateOutput> = {}): ChartGateOutput {
  const allowed = truthScore >= 75;
  return {
    chartTruthScore: truthScore, chartReadScore: 90, truthLabel: allowed ? "Verified" : "Degraded", readLabel: "Readable",
    confidentReadAllowed: allowed, scannerConfirmAllowed: allowed, selfTradeChartAllowed: allowed,
    candlestickModeAllowed: true, autonomousChartActionAllowed: true, tradeConfirmationAllowed: true,
    blockedReasons: allowed ? [] : [`Chart Truth Score ${truthScore} < 75 (Degraded) — chart-based confirmation blocked.`],
    primaryBlockReason: allowed ? null : `Chart Truth Score ${truthScore} < 75 (Degraded) — chart-based confirmation blocked.`,
    note: "fixture", ...over,
  };
}

const level = (kind: "support" | "resistance", price: number, distancePct: number) => ({
  kind, price, personality: "respected", touchCount: 3, rejectionCount: 2, breakCount: 0, retestCount: 1,
  strengthScore: 80, weaknessScore: 10, trapScore: 0, distancePct,
});

/** A clean, non-stale feed with an A-grade bullish setup (what the engines produce). */
function aGradeState(g: ChartGateOutput, feedOver: Partial<ChartFeedStatus> = {}): ChartIntelligenceState {
  const evidence = { populated: true, direction: "bullish", evidenceFor: [], evidenceAgainst: [], contradictions: [], note: "" };
  const readiness = { populated: true, score: 84, quality: "A", gates: [], vetoed: false, vetoReason: null, note: "Readiness 84 (A)." };
  const setup = { populated: true, stage: "entry_valid", direction: "bullish", ageBars: 2, decayScore: 10, freshness: 90,
    invalidationPrice: 1.0985, invalidationCondition: null };
  return {
    symbol: "TESTFX_FIXTURE", displaySymbol: "TESTFX", timeframe: "M5", assetClass: "forex",
    aiUsable: true, stale: false, truthState: { ...feed, ...feedOver },
    currentCandle: null, latestClosedCandle: null,
    candleStats: { barsAnalyzed: 200, direction: "up", lastClose: 1.1, changeAbs: 0.0001, changePct: 0.01,
      range: 0.002, body: 0.001, avgRange: 0.002, atr: 0.002 },
    fastFlags: { populated: true, momentumBurst: false, nearRecentHigh: false, nearRecentLow: false, note: null },
    marketUnderstanding: {
      populated: true,
      trend: { populated: true, regime: "trending", direction: "bullish" },
      levels: { populated: true, levels: [level("support", 1.0992, -0.07), level("resistance", 1.102, 0.18)],
        nearestSupport: level("support", 1.0992, -0.07), nearestResistance: level("resistance", 1.102, 0.18),
        eventsRemembered: 0, note: "" },
      candleIntent: { populated: true, latestIntent: "pushing", dominantPressure: "buyers" },
      timeframeAgreement: { populated: true, agreementScore: 80, alignedDirection: "bullish", scalpOnlyWarning: false },
      evidence, readiness, note: "",
    },
    setupState: setup,
    decisionState: { populated: true, bias: "bullish", quality: "A", actionability: "ready", vetoed: false,
      decision: "ready — long bias, quality A", note: "Read-only summary of the engine outputs." },
    decisionReasoning: { populated: false },
    decisionFork: { populated: true, downgrade: false, downgradeReason: null },
    agentConsensus: { populated: false, note: "shadow", cautions: [] },
    trendlineOverlay: { visible: false },
    speedState: {},
    lastUpdated: new Date(epoch).toISOString(),
    // Every handshake check measured (bound broker quote, renderer evidence);
    // the headline score follows the gate under test.
    chartTruthScore: { ...withMeasuredRender(boundScore()), score: g.chartTruthScore },
    chartReadScore: { score: 90, label: "Readable", subMetrics: [], primaryConcern: null, note: "" },
    gateOutput: g,
    brokerAlignment: noBrokerAlignment(1.1, "LAST"),
  } as unknown as ChartIntelligenceState;
}

function sentencesFor(s: ChartIntelligenceState) {
  const { marketSentences: _drop, ...input } = s as ChartIntelligenceState & { marketSentences?: unknown };
  return buildMarketSentences(input);
}

test("verified A-grade read keeps 'ready' and the act-with-a-stop sentence", () => {
  const s = aGradeState(gate(87));
  const v = chartReadVerification(s.gateOutput, s.truthState, s.chartTruthScore);
  assert.deepEqual(v, { verified: true, reasons: [] });
  assert.equal(capDecisionStateByChartTruth(s.decisionState, v).actionability, "ready");
  assert.match(sentencesFor(s).bestNextAction.text, /act with a defined stop/);
});

test("Chart Truth 70 (< 75): decision is capped at watch and best action does not invite action", () => {
  const s = aGradeState(gate(70));
  const v = chartReadVerification(s.gateOutput, s.truthState, s.chartTruthScore);
  assert.equal(v.verified, false);
  assert.match(v.reasons[0]!, /Chart Truth is 70\/100, below the 75 needed for a verified read/);
  const capped = capDecisionStateByChartTruth(s.decisionState, v);
  assert.equal(capped.actionability, "watch");
  assert.equal(capped.quality, "A", "the candle grade itself is unchanged");
  assert.match(capped.note, /not verified: Chart Truth is 70\/100/);
  assert.match(capped.decision ?? "", /^watch — long bias, quality A \(not verified\)$/);

  const sentences = sentencesFor({ ...s, decisionState: capped });
  assert.doesNotMatch(sentences.bestNextAction.text, /act with a defined stop/);
  assert.doesNotMatch(sentences.bestNextAction.text, /cleanest it gets/);
  assert.match(sentences.bestNextAction.text, /not verified/);
  assert.match(sentences.bestNextAction.text, /Chart Truth is 70\/100/);
  assert.equal(sentences.bestNextAction.tone, "caution");
  // "Entry timing is valid now" is the same invitation; it must say the read is unverified.
  assert.doesNotMatch(sentences.entryTiming.text, /^Entry timing is valid now/);
  assert.match(sentences.entryTiming.text, /not verified/);
  // So is "a scalp can work if you respect a tight stop".
  const burst = sentencesFor({ ...s, decisionState: capped, fastFlags: { ...s.fastFlags, momentumBurst: true } });
  assert.doesNotMatch(burst.scalp.text, /scalp can work/);
  assert.match(burst.scalp.text, /not verified/);
});

test("the sentence engine alone never says 'act with a defined stop' on an unverified read", () => {
  // Even if a caller hands it an uncapped 'ready' summary.
  const s = aGradeState(gate(70));
  const text = sentencesFor(s).bestNextAction.text;
  assert.doesNotMatch(text, /act with a defined stop/);
  assert.match(text, /not verified/);
});

test("a feed that is not live (weekend closure / stored bars) cannot back 'ready'", () => {
  const s = aGradeState(gate(87), { isLive: false });
  const v = chartReadVerification(s.gateOutput, s.truthState, s.chartTruthScore);
  assert.equal(v.verified, false);
  assert.ok(v.reasons.includes("the feed is not live right now"));
  assert.equal(capDecisionStateByChartTruth(s.decisionState, v).actionability, "watch");
  assert.doesNotMatch(sentencesFor(s).bestNextAction.text, /act with a defined stop/);
});

test("a failed broker mirror or stale feed also blocks 'ready'; missing gate is not verified", () => {
  const mirror = chartReadVerification(gate(87, { tradeConfirmationAllowed: false,
    blockedReasons: ["Broker price alignment failed — chart-based trade confirmation blocked."] }), feed, boundScore());
  assert.equal(mirror.verified, false);
  assert.match(mirror.reasons.join(" "), /broker-mirror check/);
  const stale = chartReadVerification(gate(87, { autonomousChartActionAllowed: false }), feed, boundScore());
  assert.match(stale.reasons.join(" "), /stale/);
  assert.equal(chartReadVerification(null, feed, boundScore()).verified, false);
  assert.equal(chartReadVerification(gate(87), null, boundScore()).verified, false);
  assert.equal(chartReadVerification(gate(87), feed, null).verified, false);
});

test("the cap only lowers: prepare → watch, watch / stand_aside / unpopulated unchanged", () => {
  const v = chartReadVerification(gate(60), feed, boundScore());
  const base = aGradeState(gate(60)).decisionState;
  assert.equal(capDecisionStateByChartTruth({ ...base, actionability: "prepare" }, v).actionability, "watch");
  for (const a of ["watch", "stand_aside", "unknown"] as const) {
    const d = { ...base, actionability: a };
    assert.equal(capDecisionStateByChartTruth(d, v), d);
  }
  const unpop = { ...base, populated: false };
  assert.equal(capDecisionStateByChartTruth(unpop, v), unpop);
});

test("route enrichment re-derives the summary from the per-user gate (both directions)", async () => {
  const { enrichStateWithBrokerAlignment } = await import("../chartIntelligence.js");
  const truth = truthFixture();

  // A state built under a closed gate (placeholder alignment) carries a capped summary…
  const built = aGradeState(gate(70));
  built.decisionState = capDecisionStateByChartTruth(built.decisionState, chartReadVerification(built.gateOutput, feed, built.chartTruthScore));
  built.marketSentences = sentencesFor(built);
  assert.equal(built.decisionState.actionability, "watch");

  // …and a bound, matching broker quote verifies it: the summary is ready again.
  const quoteBinding = bindBrokerQuote({
    series: { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 7, userId: 70, environment: "unknown", brokerSymbol: null },
    quote: { source: "mt5_live_quote", providerId: "mt5_broker", bridgeConnectionId: 7, userId: 70, environment: null, brokerSymbol: null,
      tickAt: new Date(epoch).toISOString(), bid: 1.09999, ask: 1.10001, spreadPoints: 2 },
    requestingUserId: 70, now: epoch + 1_000,
  });
  const verifiedInputs = { chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex" as const,
    brokerBid: 1.09999, brokerAsk: 1.10001, spreadPoints: 2, quoteBinding };
  assert.ok(computeChartTruthScore(truth, feed, computeBrokerPriceAlignment(verifiedInputs)).score >= 75);
  const enriched = enrichStateWithBrokerAlignment(built, truth, feed, verifiedInputs);
  assert.equal(enriched.gateOutput.confidentReadAllowed, true);
  // Re-derived under the per-user gate: every candle-data reason is gone. The
  // server never measures chart rendering, and Eleanor's VERIFIED basis keeps the
  // full handshake rollup, so the only reason left is rendering and the
  // summary stays at watch, exactly where Eleanor's read stands.
  const { buildChartHandshake } = await import("../chartHandshake.js");
  const enrichedHandshake = buildChartHandshake(enriched.gateOutput, enriched.chartTruthScore);
  assert.equal(enrichedHandshake.sourceOverall, "PASS");
  assert.notEqual(enrichedHandshake.overall, "PASS", "Eleanor's basis is not VERIFIED");
  assert.deepEqual(chartReadVerification(enriched.gateOutput, feed, enriched.chartTruthScore).reasons,
    ["chart rendering is not measured"]);
  assert.equal(enriched.decisionState.actionability, "watch");
  assert.match(enriched.decisionState.note, /chart rendering is not measured/);
  assert.doesNotMatch(enriched.marketSentences.bestNextAction.text, /act with a defined stop/);

  // An enrichment that leaves the gate closed caps a 'ready' summary.
  const weakTruth = truthFixture({ pricePrecision: null });
  const unbound = { chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex" as const,
    brokerBid: null, brokerAsk: null, spreadPoints: null };
  const closedGate = computeChartGateOutput(
    computeChartTruthScore(weakTruth, feed, computeBrokerPriceAlignment(unbound)), read as never,
    computeBrokerPriceAlignment(unbound), weakTruth, false);
  assert.equal(closedGate.confidentReadAllowed, false);
  const ready = aGradeState(gate(87));
  ready.marketSentences = sentencesFor(ready);
  const blocked = enrichStateWithBrokerAlignment(ready, weakTruth, feed, unbound);
  assert.equal(blocked.gateOutput.confidentReadAllowed, false);
  assert.equal(blocked.decisionState.actionability, "watch");
  assert.doesNotMatch(blocked.marketSentences.bestNextAction.text, /act with a defined stop/);
});

// Truth: the verification claimed "Same conditions Eleanor's chart read requires"
// but left out Eleanor's handshake check (every candle-data check measured and
// passing, real OHLC). With no bound broker quote the broker comparison is
// unmeasured, so a clean feed scores exactly 75: the gate opened, the board
// said "A · Ready" / "act with a defined stop", and Eleanor on the same tab
// answered "syncing" because BrokerPriceAlignment was WARN.
test("Chart Truth exactly 75 with no broker comparison is not verified, matching Eleanor's handshake", async () => {
  const { buildChartHandshake } = await import("../chartHandshake.js");
  const truth = truthFixture();
  const alignment = noBrokerAlignment(1.1, "LAST");
  const score = computeChartTruthScore(truth, feed, alignment);
  assert.equal(score.score, 75, "fixture: every measured check is perfect, the broker comparison is unmeasured");
  const g = computeChartGateOutput(score, read as never, alignment, truth, feed);
  assert.equal(g.confidentReadAllowed, true);
  assert.notEqual(buildChartHandshake(g, score).sourceOverall, "PASS", "Eleanor's read is syncing");

  const v = chartReadVerification(g, feed, score);
  assert.equal(v.verified, false);
  assert.ok(v.reasons.includes("the broker price comparison was not measured"), v.reasons.join("; "));

  const s = aGradeState(g);
  s.chartTruthScore = score;
  assert.equal(capDecisionStateByChartTruth(s.decisionState, v).actionability, "watch");
  const text = sentencesFor(s).bestNextAction.text;
  assert.doesNotMatch(text, /act with a defined stop|cleanest it gets/);
  assert.match(text, /broker price comparison was not measured/);
});

test("candles that are not real OHLC are not a verified read", async () => {
  const truth = truthFixture({ providerDeliversRealOhlc: false });
  const s = boundScore(truth);
  const g = computeChartGateOutput(s, read as never, boundAlignment(), truth, feed);
  assert.equal(g.candlestickModeAllowed, false);
  const v = chartReadVerification(g, feed, s);
  assert.equal(v.verified, false);
  assert.ok(v.reasons.includes("the provider does not deliver real OHLC candles"), v.reasons.join("; "));
});

test("a verified read is exactly one Eleanor's handshake also passes", async () => {
  const { buildChartHandshake } = await import("../chartHandshake.js");
  const truth = truthFixture();
  const s = withMeasuredRender(boundScore(truth));
  const g = computeChartGateOutput(s, read as never, boundAlignment(), truth, feed);
  const v = chartReadVerification(g, feed, s);
  assert.deepEqual(v, { verified: true, reasons: [] });
  // Eleanor's VERIFIED basis and draft read require the FULL rollup.
  assert.equal(buildChartHandshake(g, s).overall, "PASS");
  // A feed the candle engines do not call clean is not verified either.
  assert.equal(chartReadVerification(g, { ...feed, aiUsable: false, quality: "delayed" }, s).verified, false);
});

// Review (truth port, S02): the board's cap read the candle-data rollup
// (sourceOverall) while Eleanor's basis keeps the full rollup, RenderHealth
// included. The server never measures rendering, so the board said "Ready"
// while Eleanor, on the same read, refused a setup.
test("every candle check passing with chart rendering unmeasured is not verified, matching Eleanor's basis", async () => {
  const { buildChartHandshake } = await import("../chartHandshake.js");
  const truth = truthFixture();
  const s = boundScore(truth);
  assert.equal(s.subMetrics.find((m) => m.key === "render_accuracy")?.evidenceStatus, "unavailable");
  const g = computeChartGateOutput(s, read as never, boundAlignment(), truth, feed);
  const h = buildChartHandshake(g, s);
  assert.equal(h.sourceOverall, "PASS", "fixture: every candle-data check passes");
  assert.notEqual(h.overall, "PASS", "Eleanor's basis is not VERIFIED");
  const v = chartReadVerification(g, feed, s);
  assert.deepEqual(v, { verified: false, reasons: ["chart rendering is not measured"] });
  const state = aGradeState(g);
  state.chartTruthScore = s;
  assert.equal(capDecisionStateByChartTruth(state.decisionState, v).actionability, "watch");
  const text = sentencesFor(state).bestNextAction.text;
  assert.doesNotMatch(text, /act with a defined stop|cleanest it gets/);
  assert.match(text, /chart rendering is not measured/);
  // A measured renderer below the pass mark is named with its score.
  const weak = { ...s, subMetrics: s.subMetrics.map((m) => m.key === "render_accuracy"
    ? { ...m, rawScore: 60, evidenceStatus: "measured" as const } : m) };
  assert.deepEqual(chartReadVerification(g, feed, weak).reasons, ["chart rendering scored 60/100 (needs 75)"]);
});

// Truth: tradeConfirmationAllowed is false for a merge-seam failure OR a failed
// broker comparison, but every false was reported as "the chart's prices
// failed the broker-mirror check" — even with no broker quote, when no broker
// comparison ran. The reason now names the cause the gate recorded.
test("a merge-seam failure with no broker quote is not blamed on a broker comparison", () => {
  const truth = truthFixture({ mergeSeam: { formingBarDetected: true, formingBarCount: 1, gapAtSeam: false, overlapAtSeam: true, seamGapIntervals: 0 } });
  const alignment = noBrokerAlignment(1.1, "LAST");
  assert.equal(alignment.brokerDataAvailable, false);
  const score = computeChartTruthScore(truth, feed, alignment);
  const g = computeChartGateOutput(score, read as never, alignment, truth, feed);
  assert.equal(g.tradeConfirmationAllowed, false);
  const v = chartReadVerification(g, feed, score);
  assert.equal(v.verified, false);
  const why = v.reasons.join("; ");
  assert.doesNotMatch(why, /broker-mirror|failed the broker/);
  assert.ok(v.reasons.includes("the chart's history and live bars do not join cleanly"), why);
  const s = aGradeState(g);
  s.chartTruthScore = score;
  assert.doesNotMatch(sentencesFor(s).bestNextAction.text, /broker-mirror/);
});

test("a broker comparison that ran and failed keeps the broker-mirror wording", () => {
  const g = computeChartGateOutput(boundScore(), read as never,
    { ...boundAlignment(), tolerance: "failed" }, truthFixture(), feed);
  assert.equal(g.tradeConfirmationAllowed, false);
  const v = chartReadVerification(g, feed, boundScore());
  assert.ok(v.reasons.includes("the chart's prices failed the broker-mirror check"), v.reasons.join("; "));
  assert.ok(!v.reasons.includes("the chart's history and live bars do not join cleanly"));
});

// Truth: the scalp-only branch returned before the read-verification check,
// so on an unverified read the Scalp sentence still said "keep it small and
// fast" / "only quick in-and-out trades make sense here" while Pulse said the
// read was not verified and watch-only.
test("scalp-only conditions on an unverified read do not invite a scalp", () => {
  const s = aGradeState(gate(70));
  const scalpOnly = { ...s.marketUnderstanding.timeframeAgreement, scalpOnlyWarning: true };
  const mu = { ...s.marketUnderstanding, timeframeAgreement: scalpOnly };
  for (const momentumBurst of [true, false]) {
    const text = sentencesFor({ ...s, marketUnderstanding: mu, fastFlags: { ...s.fastFlags, momentumBurst } }).scalp.text;
    assert.doesNotMatch(text, /keep it small and fast|make sense here/);
    assert.match(text, /not verified/);
    assert.match(text, /Chart Truth is 70\/100/);
    assert.match(text, /don't scalp off it yet/);
  }
  // A verified read keeps the scalp-only guidance.
  const ok = aGradeState(gate(87));
  const verifiedText = sentencesFor({ ...ok, marketUnderstanding: { ...ok.marketUnderstanding, timeframeAgreement: scalpOnly },
    fastFlags: { ...ok.fastFlags, momentumBurst: true } }).scalp.text;
  assert.match(verifiedText, /^Scalp-only: there's a quick momentum burst/);
});
