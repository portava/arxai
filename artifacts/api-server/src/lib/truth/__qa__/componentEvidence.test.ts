import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRubyMarketEdge, type SignalEngineInput } from "@workspace/domain/signal-intelligence";
import { MIN_SUFFICIENT_CLOSED_BARS } from "@workspace/domain/market";
import { composeVerdict } from "@workspace/domain/truth";
import { buildSymbolTruthSnapshot, capExpiredTruthSnapshot, type TruthSnapshotDeps } from "../symbolTruthSnapshot.js";
import { prepareMarketRead, matchedMarketQuote, evidenceMatches, isCurrentBuild } from "../marketReadEvidence.js";
import { computeTimingRead } from "../../../brain/timing/marketTimingBrainService.js";
import { NOW, marketFixture } from "./marketEvidenceFixtures.js";

const fixture = marketFixture();
const absent = async (): Promise<never> => { throw new Error("offline unavailable"); };
const inputs: SignalEngineInput = { symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", candles: fixture.result.candles,
  currentPrice: 1.098, dataSource: "LIVE_FEED", scanner: { bias: "bullish", recommendedAction: "BUY", confidenceScore: 85, entrySniperScore: 85, riskRewardRatio: 2,
    setupType: "Trend", entry: 1.098, entryZone: { from: 1.0978, to: 1.0982 }, stopLoss: 1.097, takeProfit: 1.1, reasonForTrade: "", reasonToAvoid: "" },
  scalp: null, execution: null, newsRiskLevel: null, previous: null, now: NOW };
function signal() {
  const value = buildRubyMarketEdge(inputs);
  return { ...value, marketEvidence: { ...fixture.evidence, userId: 1 } };
}
async function snapshot(scanner = signal(), over: Partial<TruthSnapshotDeps> = {}) {
  return buildSymbolTruthSnapshot("EURUSD", "M15", 1, {
    getChartCandlesFn: async () => fixture.chart as never, buildNewsFn: absent,
    evaluateScalpFn: absent, computeTimingFn: absent, buildScannerFn: async () => scanner, ...over,
  });
}
const quietTiming = { computeNewsHeatFn: async () => ({ phase: "NONE", eventName: null, minutesUntil: null, minutesSince: null, eventType: "none", surpriseScore: null, heatAdjustment: 0, blocksTrade: false }) as never,
  computeBroadFlowFn: async () => ({ verdict: "UNAVAILABLE", institutionalFlowScore: 50, competingCatalyst: false, description: "", correlatedAssets: [], dataQuality: "unavailable" }) as never };

test("real expired Ruby output cannot become a fresh actionable snapshot", async () => {
  const old = new Date(NOW - 86_400_000).toISOString();
  const expired = { ...buildRubyMarketEdge({ ...inputs, previous: { ...signal(), firstSeenAt: old, generatedAt: old, overallScore: 80 } }), marketEvidence: { ...fixture.evidence, userId: 1 } };
  assert.equal(expired.hasSufficientData, true); assert.equal(expired.direction, "BUY"); assert.equal(expired.lifecycleStage, "EXPIRED");
  const result = await snapshot(expired);
  assert.equal(result.components.scanner.present, false); assert.equal(result.levels.withheld, true); assert.equal(result.verdict.bestAction, "WATCH_ONLY");
});

test("real timing producer rejects old ascending bars and stale quote despite current build time", async () => {
  const stale = marketFixture({ source: "assistant_real:twelve_data", ageMs: 86_400_000 });
  stale.quote.provenance!.source = "STALE";
  const timing = await computeTimingRead({ symbol: "EURUSD", timeframe: "M15", persistSnapshot: false }, { ...quietTiming, routeCandlesFn: async () => stale.result, routeQuoteFn: async () => stale.quote });
  assert.equal(timing.marketEvidence, null); assert.equal(timing.dataQuality.hasCandleData, false); assert.equal(timing.dataQuality.hasQuoteData, false);
  const result = await snapshot(signal(), { buildScannerFn: absent, computeTimingFn: async () => timing });
  assert.equal(result.components.timing.present, false); assert.equal(result.verdict.bestAction, "WATCH_ONLY");
});

test("current real timing output keeps source/bar observation separate from generation and has no geometry-only BUY", async () => {
  const timing = await computeTimingRead({ symbol: "EURUSD", timeframe: "M15", persistSnapshot: false }, { ...quietTiming, routeCandlesFn: async () => fixture.result, routeQuoteFn: async () => fixture.quote });
  assert.equal(timing.marketEvidence?.lastClosedCandleAt, fixture.evidence.lastClosedCandleAt);
  const result = await snapshot(signal(), { buildScannerFn: absent, computeTimingFn: async () => timing });
  assert.equal(result.components.timing.present, true); assert.equal(result.components.timing.asOf, fixture.evidence.lastClosedCandleAt);
  assert.equal(result.verdict.bestAction, "WATCH_ONLY"); assert.equal(result.levels.withheld, true);
});

for (const [name, mutate] of Object.entries({
  "missing evidence": (s: ReturnType<typeof signal>) => { s.marketEvidence = null as never; },
  "wrong user": (s: ReturnType<typeof signal>) => { s.marketEvidence.userId = 2; },
  "wrong timeframe": (s: ReturnType<typeof signal>) => { s.marketEvidence.timeframe = "M5"; },
  "wrong source": (s: ReturnType<typeof signal>) => { s.marketEvidence.source = "deriv_public"; },
  "different bridge": (s: ReturnType<typeof signal>) => { s.marketEvidence.sourceIdentity = marketFixture({ bridge: 9 }).evidence.sourceIdentity; },
  "previous bar": (s: ReturnType<typeof signal>) => { s.marketEvidence.lastClosedCandleAt = new Date(Date.parse(s.marketEvidence.lastClosedCandleAt) - 900_000).toISOString(); },
  "future build": (s: ReturnType<typeof signal>) => { s.generatedAt = new Date(NOW + 60_000).toISOString(); },
  "old build": (s: ReturnType<typeof signal>) => { s.generatedAt = new Date(NOW - 60_000).toISOString(); },
  "invalid lifecycle": (s: ReturnType<typeof signal>) => { s.lifecycleStage = "INVALID"; },
  "stale setup": (s: ReturnType<typeof signal>) => { s.freshness = "STALE"; },
})) test(`${name} cannot vote or donate scanner geometry`, async () => {
  const value = signal(); mutate(value); const result = await snapshot(value);
  assert.equal(result.components.scanner.present, false); assert.equal(result.levels.withheld, true); assert.equal(result.verdict.bestAction, "WATCH_ONLY");
});

test("matching current scanner remains present with genuine confirmed-bar asOf", async () => {
  const result = await snapshot(); assert.equal(result.components.scanner.present, true);
  assert.equal(result.components.scanner.asOf, fixture.evidence.lastClosedCandleAt);
});

test("forming provider bar has scheduled future close but never becomes confirmed evidence or sufficient history", async () => {
  const f = marketFixture({ count: MIN_SUFFICIENT_CLOSED_BARS - 1, forming: true });
  const read = prepareMarketRead(f.result, "EURUSD", "M15", NOW)!;
  assert.equal(read.openClosed.length, MIN_SUFFICIENT_CLOSED_BARS - 1); assert.equal(read.evidence.lastClosedCandleAt, f.evidence.lastClosedCandleAt);
  assert.ok(Date.parse(f.chart.feedStatus.lastCandleTime!) > NOW);
  const result = await snapshot(signal(), { getChartCandlesFn: async () => f.chart as never });
  assert.equal(result.verdict.bias, "UNKNOWN"); assert.notEqual(result.verdict.bestAction, "BUY");
});

test("missing provenance, malformed values, wrong symbol and denser timeframe cannot acquire evidence", () => {
  for (const mutate of [(f: typeof fixture) => { f.result.provenance = undefined; }, (f: typeof fixture) => { f.result.symbol = "GBPUSD"; },
    (f: typeof fixture) => { f.result.candles[3]!.high = NaN; }, (f: typeof fixture) => { f.result.provenance!.sourceId = "mt5_broker:EURUSD:M5"; }]) {
    const f = marketFixture(); mutate(f); assert.equal(prepareMarketRead(f.result, "EURUSD", "M15", NOW), null);
  }
  const f = marketFixture({ timeframe: "M5" }); f.result.provenance!.sourceId = "mt5_broker:EURUSD:M15";
  assert.equal(prepareMarketRead(f.result, "EURUSD", "M15", NOW), null);
});

test("quote price requires current exact observed attribution and a real spread", () => {
  const f = marketFixture({ bridge: 4 }); assert.ok(matchedMarketQuote(f.result, f.quote, "EURUSD", NOW));
  f.quote.provenance!.bridgeConnectionId = null; assert.equal(matchedMarketQuote(f.result, f.quote, "EURUSD", NOW), null);
  f.quote.provenance!.bridgeConnectionId = 4; f.quote.quote!.timestamp = new Date(NOW - 60_000).toISOString();
  assert.equal(matchedMarketQuote(f.result, f.quote, "EURUSD", NOW), null);
  f.quote.quote!.timestamp = new Date(NOW).toISOString(); f.quote.quote!.ask = f.quote.quote!.bid;
  assert.equal(matchedMarketQuote(f.result, f.quote, "EURUSD", NOW), null);
});

test("build deadline and closed-bar deadline are independent, inclusive build horizon is bounded", () => {
  assert.equal(isCurrentBuild(new Date(NOW - 30_000).toISOString(), NOW), true);
  assert.equal(isCurrentBuild(new Date(NOW - 30_001).toISOString(), NOW), false);
  assert.equal(evidenceMatches(fixture.evidence, fixture.evidence, NOW), true);
  assert.equal(evidenceMatches(fixture.evidence, fixture.evidence, Date.parse(fixture.evidence.lastClosedCandleAt) + 900_000), false);
});

for (const [name, change] of Object.entries({ missingEntry: { entryFrom: null }, missingStop: { stopLoss: null }, emptyTargets: { takeProfit: [] }, nonfiniteTarget: { takeProfit: [NaN] }, reversedZone: { entryFrom: 1.102 }, wrongStop: { stopLoss: 1.101 }, wrongTarget: { takeProfit: [1.098] }, wrongInvalidation: { invalidation: 1.101 } })) test(`usable geometry required: ${name}`, () => {
  const result = composeVerdict({ dataState: "LIVE_CONFIRMED", price: 1.1, highImpactWindowActive: false, components: [{ key: "timing", present: true, alignment: "BULLISH", label: "", asOf: null }], levels: { entryFrom: 1.0998, entryTo: 1.1002, stopLoss: 1.099, invalidation: null, takeProfit: [1.101], ...change } });
  assert.equal(result.bestAction, "WATCH_ONLY"); assert.equal(result.levels.withheld, true); assert.equal(result.invalidation, null);
});

test("genuine current geometry keeps BUY and SELL advice, with no execution permission added", () => {
  for (const side of ["BULLISH", "BEARISH"] as const) {
    const result = composeVerdict({ dataState: "LIVE_CONFIRMED", price: 1.1, highImpactWindowActive: false,
      components: [{ key: "scanner", present: true, alignment: side, label: "", asOf: null }],
      levels: { entryFrom: 1.0998, entryTo: 1.1002, stopLoss: side === "BULLISH" ? 1.099 : 1.101, invalidation: null, takeProfit: [side === "BULLISH" ? 1.101 : 1.099] } });
    assert.equal(result.bestAction, side === "BULLISH" ? "BUY" : "SELL"); assert.equal(result.levels.withheld, false);
  }
});

test("M5 scalp/flame votes match M5 only, expire honestly and never recast M15", async () => {
  const f = marketFixture({ timeframe: "M5" });
  const scalp = { symbol: "EURUSD", generatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), validForSeconds: 60,
    marketEvidence: { ...f.evidence, userId: 1 }, direction: "BUY", status: "READY", flame: { blind: false, readDirection: "BUY", flameStage: "IGNITING", freshness: "FRESH" } };
  let passedScalp: unknown;
  const deps: Partial<TruthSnapshotDeps> = { getChartCandlesFn: async () => f.chart as never, buildNewsFn: absent, computeTimingFn: absent,
    evaluateScalpFn: async () => scalp as never, buildScannerFn: async (_uid, _args, options) => { passedScalp = options?.scalp; return null as never; } };
  const m5 = await buildSymbolTruthSnapshot("EURUSD", "M5", 1, deps);
  assert.equal(m5.components.flame.present, true); assert.equal(m5.components.scalp.present, true); assert.equal(passedScalp, scalp);
  const m15 = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, { ...deps, getChartCandlesFn: async () => fixture.chart as never });
  assert.equal(m15.components.flame.present, false); assert.equal(m15.components.scalp.present, false); assert.equal(passedScalp, null); assert.match(m15.components.scalp.label, /M5/);
  scalp.expiresAt = new Date(NOW - 1).toISOString();
  const expired = await buildSymbolTruthSnapshot("EURUSD", "M5", 1, deps); assert.equal(expired.components.flame.present, false); assert.equal(expired.components.scalp.present, false);
});

test("a valid Deriv public forming candle remains chart context while votes use the preceding closed bar", async () => {
  const f = marketFixture({ symbol: "V50", source: "deriv_public", forming: true });
  const read = prepareMarketRead(f.result, "V50", "M15", NOW)!;
  assert.equal(read.evidence.source, "deriv_public"); assert.equal(read.openClosed.length, 80);
  const valid = { ...signal(), symbol: "V50", marketEvidence: { ...read.evidence, userId: 1 } };
  const result = await buildSymbolTruthSnapshot("V50", "M15", 1, { getChartCandlesFn: async () => f.chart as never, buildNewsFn: absent, evaluateScalpFn: absent, computeTimingFn: absent, buildScannerFn: async () => valid });
  assert.equal(result.components.scanner.present, true);
  // The forming candle stays chart context (its close is the newest price), but
  // its scheduled future close is not an observation: lastCandleAt is the
  // preceding closed bar's close.
  assert.equal(result.data.price, f.chart.candles.at(-1)!.close);
  assert.equal(result.data.lastCandleAt, read.evidence.lastClosedCandleAt);
  assert.ok(Date.parse(result.data.lastCandleAt!) <= NOW);
  assert.ok(Date.parse(result.components.scanner.asOf!) <= NOW);
});


test("component expiry inside the 4.5-second cache window withdraws votes without refreshing timestamps", async () => {
  const s = signal(); s.expiresAt = new Date(NOW + 2000).toISOString();
  const before = await snapshot(s); const deadline = Date.parse(before.validUntil!);
  assert.equal(capExpiredTruthSnapshot(before, deadline - 1), before);
  const after = capExpiredTruthSnapshot(before, deadline);
  assert.equal(after.components.scanner.present, false); assert.equal(after.verdict.bestAction, "WATCH_ONLY");
  assert.equal(after.generatedAt, before.generatedAt); assert.deepEqual(after.data, before.data);
  assert.equal(before.components.scanner.present, true, "cached original is not mutated");
});

// Contract the dashboard honours (symbolTruthEvidence.ts): validUntil is never
// later than the scheduled close of the forming bar, so on 1m a read expires
// every minute; expiry withdraws the candle-derived advice but the calendar
// state is NOT candle evidence and survives unchanged. The client must not
// discard it either (owner screenshot 2026-10-27: "Event risk is loading…").
test("validUntil never outlives the forming bar, and expiry keeps the calendar state unchanged", async () => {
  const news = { radar: { provider: { connected: false, name: "none" }, events: [], highImpactWindowActive: false, topSeverity: null } };
  const before = await snapshot(signal(), { buildNewsFn: async () => news as never });
  const barClose = Date.parse(fixture.evidence.lastClosedCandleAt) + 15 * 60_000;
  assert.ok(before.validUntil != null && Date.parse(before.validUntil) <= barClose);
  assert.equal(before.news.riskLabel, "No event calendar is connected.");
  const after = capExpiredTruthSnapshot(before, Date.parse(before.validUntil!));
  assert.equal(after.verdict.bestAction, "WATCH_ONLY");
  assert.deepEqual(after.news, before.news);
  assert.deepEqual(after.data, before.data);
});
