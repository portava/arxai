// Chart Truth broker comparison is earned only by a quote bound to the served
// series' observed identity with an observed, current tick time.
//
// Pure/in-memory: pushes into the in-memory MT5 store and runs the actual chart
// producer for a synthetic symbol (alwaysOpen fast path, no DB). No provider,
// DB, broker or EA call. Every identity/price/time below is a fixture input;
// none is synthesized by the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCandleTruth, type TimeframeTruthResult } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";
import { computeChartGateOutput } from "../chartGateOutput.js";
import { buildChartHandshake } from "../chartHandshake.js";
import { computeBrokerPriceAlignment, hasMeasuredBrokerAlignment, mirrorTrustSegment } from "../brokerPriceAlignment.js";
import {
  bindBrokerQuote,
  chartSeriesAttribution,
  isBoundBrokerQuote,
  observationFromMt5Quote,
  observationFromSymbolSpec,
  selectBrokerQuote,
  type BrokerQuoteObservation,
  type ChartSeriesAttribution,
} from "../brokerQuoteBinding.js";
import { getChartCandles, type ChartFeedStatus } from "../chartDataService.js";
import { __resetMt5ProviderStore, readMt5Quote, updateCandlesFromMT5, updateQuoteFromMT5 } from "../../providers/mt5Provider.js";
import { timeframeMs } from "../timeframes.js";
import { GetMeChartIntelligenceResponse } from "@workspace/api-zod";

const epoch = 1_700_000_000_000;
function fixture(): TimeframeTruthResult {
  const result = runCandleTruth(Array.from({ length: 200 }, (_, i) => ({
    time: new Date(epoch + i * 300_000).toISOString(), open: 1.1, high: 1.101, low: 1.099, close: 1.1,
  })), { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", timeframe: "M5", source: "dev",
    assetClass: "forex", limit: 200, now: epoch + 199 * 300_000 + 60_000 }).truthResult;
  return { ...result, assessment: "CLEAN", assessmentReasons: [], sourceMode: "live",
    providerDeliversRealOhlc: true, mockDataDetected: false, pricePrecision: 5,
    mergeSeam: { formingBarDetected: true, formingBarCount: 1, gapAtSeam: false, overlapAtSeam: false, seamGapIntervals: 0 } };
}
const feed: ChartFeedStatus = { symbol: "TESTFX_FIXTURE", displaySymbol: "Offline fixture", assetClass: "forex",
  source: "mt5_broker", isLive: true, lastTickTime: null, lastCandleTime: new Date(epoch).toISOString(), latencyMs: null,
  missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0, invalidOhlcCount: 0, trailingIntervals: 0,
  stale: false, quality: "clean", warning: null, aiUsable: true, feedReadinessState: null, message: "Offline fixture",
  completenessReason: null };
const read = { score: 100, label: "Highly Readable" as const, subMetrics: [], primaryConcern: null, note: "Offline fixture" };

const series: ChartSeriesAttribution = { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 7, userId: 70, environment: "unknown", brokerSymbol: null };
const now = epoch + 2_000;
function quote(over: Partial<BrokerQuoteObservation> = {}): BrokerQuoteObservation {
  return { source: "mt5_live_quote", providerId: "mt5_broker", bridgeConnectionId: 7, userId: 70, environment: null, brokerSymbol: null,
    tickAt: new Date(epoch).toISOString(), bid: 1.09999, ask: 1.10001, spreadPoints: null, ...over };
}
function evaluate(q: BrokerQuoteObservation, s: ChartSeriesAttribution | null = series, requester: number | null = 70) {
  const binding = bindBrokerQuote({ series: s, quote: q, requestingUserId: requester, now });
  const alignment = computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
    brokerBid: q.bid, brokerAsk: q.ask, spreadPoints: q.spreadPoints, quoteBinding: binding });
  const truth = fixture();
  const score = computeChartTruthScore(truth, feed, alignment);
  const gate = computeChartGateOutput(score, read, alignment, truth, false);
  const mirror = score.subMetrics.find(m => m.key === "symbol_mirror_accuracy")!;
  return { binding, alignment, score, gate, mirror, handshake: buildChartHandshake(gate, score) };
}

test("same-identity quote with an observed current tick earns the broker comparison", () => {
  const r = evaluate(quote());
  assert.equal(r.binding.status, "BOUND"); assert.deepEqual(r.binding.reasons, []);
  assert.equal(r.binding.quoteAgeMs, 2_000); assert.equal(r.binding.freshnessBudgetMs, 15_000);
  assert.equal(r.alignment.aligned, true); assert.equal(hasMeasuredBrokerAlignment(r.alignment), true);
  assert.equal(r.mirror.evidenceStatus, "measured"); assert.equal(r.mirror.rawScore, 100);
  assert.equal(r.score.score, 87); assert.equal(r.handshake.BrokerPriceAlignment, "PASS");
  assert.equal(mirrorTrustSegment(r.gate.tradeConfirmationAllowed, r.alignment), "Mirror synced");
});

test("the same numbers without a binding stay unmeasured and make no alignment claim", () => {
  const alignment = computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex",
    brokerBid: 1.09999, brokerAsk: 1.10001, spreadPoints: 2 });
  assert.equal(alignment.brokerDataAvailable, true); assert.equal(alignment.aligned, false); assert.equal(alignment.quoteBinding, null);
  const score = computeChartTruthScore(fixture(), feed, alignment);
  const mirror = score.subMetrics.find(m => m.key === "symbol_mirror_accuracy")!;
  assert.equal(mirror.rawScore, null); assert.equal(mirror.weightedScore, null);
  assert.match(mirror.detail, /not evaluated/); assert.equal(score.score, 75);
  const gate = computeChartGateOutput(score, read, alignment, fixture(), false);
  assert.notEqual(buildChartHandshake(gate, score).BrokerPriceAlignment, "PASS");
  assert.equal(mirrorTrustSegment(gate.tradeConfirmationAllowed, alignment), null);
});

for (const [name, q, s, requester, status, reason] of [
  ["another bridge", quote({ bridgeConnectionId: 8 }), series, 70, "MISMATCH", "BRIDGE_MISMATCH"],
  ["another owner", quote({ userId: 71 }), series, 70, "MISMATCH", "OWNER_MISMATCH"],
  ["another user's account", quote({ userId: 71 }), { ...series, userId: 71 }, 70, "MISMATCH", "ACCOUNT_NOT_REQUESTER"],
  ["another provider", quote({ providerId: "deriv" }), series, 70, "MISMATCH", "PROVIDER_MISMATCH"],
  ["contradicting environment", quote({ environment: "live" }), { ...series, environment: "demo" }, 70, "MISMATCH", "ENVIRONMENT_MISMATCH"],
  ["contradicting native symbol", quote({ brokerSymbol: "EURUSD.m" }), { ...series, brokerSymbol: "EURUSD" }, 70, "MISMATCH", "BROKER_SYMBOL_MISMATCH"],
  ["stale tick", quote({ tickAt: new Date(now - 15_001).toISOString() }), series, 70, "STALE", "QUOTE_STALE"],
  ["future tick", quote({ tickAt: new Date(now + 1).toISOString() }), series, 70, "STALE", "QUOTE_TIME_FUTURE"],
  ["receive-time only", quote({ tickAt: null }), series, 70, "UNVERIFIED", "QUOTE_TIME_UNKNOWN"],
  ["malformed tick time", quote({ tickAt: "not-a-time" }), series, 70, "UNVERIFIED", "QUOTE_TIME_UNKNOWN"],
  ["unattributed quote", quote({ bridgeConnectionId: null, userId: null }), series, 70, "UNVERIFIED", "QUOTE_UNATTRIBUTED"],
  ["unattributed durable-mirror series", quote(), { ...series, subProviderId: "durable_mirror", bridgeConnectionId: null, userId: null }, 70, "UNVERIFIED", "SERIES_UNATTRIBUTED"],
  ["no series provenance", quote(), null, 70, "UNVERIFIED", "SERIES_UNATTRIBUTED"],
  ["unknown requester", quote(), series, null, "UNVERIFIED", "REQUESTER_UNKNOWN"],
] as const) test(`${name} keeps the broker comparison unmeasured with a visible reason`, () => {
  const r = evaluate(q, s, requester);
  assert.equal(r.binding.status, status); assert.ok(r.binding.reasons.includes(reason), r.binding.reasons.join(","));
  assert.equal(r.alignment.aligned, false); assert.equal(hasMeasuredBrokerAlignment(r.alignment), false);
  assert.equal(r.mirror.rawScore, null); assert.equal(r.mirror.evidenceStatus, "unavailable");
  assert.ok(r.mirror.detail.includes(reason), r.mirror.detail);
  assert.ok(r.score.unmeasuredKeys.includes("symbol_mirror_accuracy"));
  assert.notEqual(r.handshake.BrokerPriceAlignment, "PASS");
  assert.equal(mirrorTrustSegment(r.gate.tradeConfirmationAllowed, r.alignment), null);
  assert.doesNotMatch(r.alignment.userMessage, /aligned with broker/);
});

test("unknown environment or native symbol on one side is not a contradiction", () => {
  assert.equal(evaluate(quote({ environment: "demo", brokerSymbol: "EURUSD.m" })).binding.status, "BOUND");
  assert.equal(evaluate(quote(), { ...series, environment: "live", brokerSymbol: "EURUSD" }).binding.status, "BOUND");
});

test("an observed failed deviation from an unbound quote still blocks trade confirmation but earns nothing", () => {
  const r = evaluate(quote({ bridgeConnectionId: 8, bid: 2, ask: 2.0001 }));
  assert.equal(r.alignment.tolerance, "failed"); assert.equal(r.alignment.brokerDataAvailable, true);
  assert.equal(r.gate.tradeConfirmationAllowed, false);
  assert.equal(r.handshake.MirrorSync, "FAIL"); assert.equal(r.handshake.BrokerPriceAlignment, "WARN");
  assert.equal(r.mirror.rawScore, null);
  // A bound failed comparison is a measured FAIL in its named field.
  const boundFail = evaluate(quote({ bid: 2, ask: 2.0001 }));
  assert.equal(boundFail.handshake.BrokerPriceAlignment, "FAIL"); assert.ok(boundFail.mirror.rawScore! < 50);
});

test("a cast or cached binding cannot claim BOUND with failed conditions", () => {
  const good = evaluate(quote()).alignment;
  for (const forged of [{ ...good.quoteBinding!, reasons: ["QUOTE_STALE" as const] }, { ...good.quoteBinding!, status: "bound" as never }, null, undefined]) {
    assert.equal(isBoundBrokerQuote(forged), false);
    assert.equal(hasMeasuredBrokerAlignment({ ...good, quoteBinding: forged }), false);
    assert.equal(mirrorTrustSegment(true, { ...good, quoteBinding: forged }), null);
  }
  const legacy = { ...good } as Partial<typeof good>; delete legacy.quoteBinding;
  assert.equal(hasMeasuredBrokerAlignment(legacy as typeof good), false);
});

test("candidate selection prefers a bound quote and otherwise keeps the first observed failure", () => {
  const ctx = { series, requestingUserId: 70, now };
  const stale = quote({ tickAt: new Date(now - 60_000).toISOString() });
  const snapshot = quote({ source: "mt5_symbol_snapshot", tickAt: new Date(epoch + 1_000).toISOString() });
  assert.equal(selectBrokerQuote([stale, snapshot], ctx).quote, snapshot);
  const fallback = selectBrokerQuote([null, stale, quote({ bridgeConnectionId: 9 })], ctx);
  assert.equal(fallback.quote, stale); assert.equal(fallback.binding.status, "STALE");
  const none = selectBrokerQuote([null, null], ctx);
  assert.equal(none.quote, null); assert.deepEqual(none.binding.reasons, ["QUOTE_ABSENT"]);
});

test("snapshot rows bind only from the EA tick time and never from report time", () => {
  const row = { userId: 70, bridgeConnectionId: 7, accountType: "demo", brokerSymbol: "EURUSD", bid: 1.09999, ask: 1.10001, spreadPoints: 2, lastTickTime: null };
  const missing = observationFromSymbolSpec(row)!;
  assert.equal(missing.tickAt, null); assert.equal(missing.environment, "demo");
  assert.equal(bindBrokerQuote({ series, quote: missing, requestingUserId: 70, now }).status, "UNVERIFIED");
  const ticked = observationFromSymbolSpec({ ...row, lastTickTime: new Date(epoch) })!;
  assert.equal(bindBrokerQuote({ series, quote: ticked, requestingUserId: 70, now }).status, "BOUND");
  assert.equal(observationFromSymbolSpec({ ...row, accountType: "contest" })!.environment, null);
});

test("JSON and generated schema preserve the binding and its nulls", () => {
  for (const alignment of [evaluate(quote()).alignment, evaluate(quote({ tickAt: null })).alignment,
    computeBrokerPriceAlignment({ chartPrice: 1.1, chartPriceBasis: "MID", assetClass: "forex", brokerBid: null, brokerAsk: null, spreadPoints: null })]) {
    const decoded = JSON.parse(JSON.stringify(alignment));
    assert.deepEqual(decoded, alignment);
    const parsed = GetMeChartIntelligenceResponse.shape.state.shape.brokerAlignment.parse(decoded);
    assert.equal(parsed.quoteBinding?.status ?? null, alignment.quoteBinding?.status ?? null);
    assert.equal(parsed.quoteBinding?.quoteAgeMs ?? null, alignment.quoteBinding?.quoteAgeMs ?? null);
    if (alignment.quoteBinding?.quoteObservedAt == null) assert.equal(parsed.quoteBinding?.quoteObservedAt ?? null, null);
  }
});

test("actual chart producer carries the served series identity off the wire and binds the same bridge's pushed quote", async () => {
  __resetMt5ProviderStore();
  const M5 = timeframeMs("M5");
  const wall = Date.now();
  const currentOpen = Math.floor(wall / M5) * M5;
  const bars = Array.from({ length: 40 }, (_, i) => {
    const base = 1000 + i * 0.5;
    return { time: new Date(currentOpen - (40 - i) * M5).toISOString(), open: base, high: base + 1.5, low: base - 1.5, close: base + 0.5, volume: 100 };
  });
  updateCandlesFromMT5("BOOM1000", bars, "M5", { bridgeConnectionId: 7, userId: 70 });
  updateQuoteFromMT5("BOOM1000", { symbol: "BOOM1000", bid: 1019.9, ask: 1020.1, timestamp: new Date(wall).toISOString() },
    { bridgeConnectionId: 7, userId: 70 }, { tickTimeObserved: true });
  const resp = await getChartCandles("BOOM1000", "M5", 40);
  const attribution = chartSeriesAttribution(resp);
  assert.deepEqual(attribution, { providerId: "mt5_broker", subProviderId: null, bridgeConnectionId: 7, userId: 70, environment: "unknown", brokerSymbol: null });
  assert.equal(JSON.stringify(resp).includes("bridgeConnectionId"), false);
  assert.equal(chartSeriesAttribution(JSON.parse(JSON.stringify(resp))), null);

  const live = observationFromMt5Quote(readMt5Quote("BOOM1000", { bridgeConnectionId: attribution!.bridgeConnectionId }));
  const ok = selectBrokerQuote([live], { series: attribution, requestingUserId: 70, now: Date.now() });
  assert.equal(ok.binding.status, "BOUND");
  const other = selectBrokerQuote([live], { series: attribution, requestingUserId: 71, now: Date.now() });
  assert.equal(other.binding.status, "MISMATCH"); assert.ok(other.binding.reasons.includes("ACCOUNT_NOT_REQUESTER"));

  updateQuoteFromMT5("BOOM1000", { symbol: "BOOM1000", bid: 1019.9, ask: 1020.1, timestamp: new Date().toISOString() },
    { bridgeConnectionId: 7, userId: 70 }, { tickTimeObserved: false });
  const unobserved = observationFromMt5Quote(readMt5Quote("BOOM1000", { bridgeConnectionId: 7 }));
  assert.equal(unobserved!.tickAt, null);
  assert.equal(selectBrokerQuote([unobserved], { series: attribution, requestingUserId: 70, now: Date.now() }).binding.status, "UNVERIFIED");
  __resetMt5ProviderStore();
});
