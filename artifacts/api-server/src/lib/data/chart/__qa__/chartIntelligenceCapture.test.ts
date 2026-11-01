import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import type { ChartCandlesResponse, ChartFeedStatus } from "../chartDataService.js";
import { runCandleTruth } from "../candleTruthEngine.js";
import { computeChartTruthScore } from "../chartTruthScore.js";

// Only external/provider, persistence and background seams are doubled. The
// actual builder and all deterministic intelligence engines execute below.
const responses = new Map<string, ChartCandlesResponse>();
const calls: string[] = [];
let memoryWait: (() => Promise<void>) | null = null;
let consensusWait: (() => Promise<void>) | null = null;
mock.module(new URL("../chartDataService.js", import.meta.url).href, { namedExports: {
  getChartCandles: async (symbol: string) => { calls.push(symbol); const r = responses.get(symbol); assert.ok(r); return r; },
} });
mock.module(new URL("../engines/chartMarketMemory.js", import.meta.url).href, { namedExports: {
  getRecentChartEvents: async () => { await memoryWait?.(); return []; },
  recordChartEvents: async () => {},
} });
mock.module(new URL("../engines/timeframeAgreement.js", import.meta.url).href, { namedExports: {
  getTimeframeAgreement: () => ({ populated: false, agreementScore: null, alignedDirection: "unknown", scalpOnlyWarning: false, timeframes: [], computedAt: null, note: "Offline background seam" }),
} });
mock.module(new URL("../chartAgentConsensus.js", import.meta.url).href, { namedExports: {
  computeChartAgentConsensus: async () => { await consensusWait?.(); return { populated: false, headline: "No consensus", detail: "", stance: "neutral", conflict: false, protective: false, influencingAgentCount: 0, agents: [], cautions: [], note: "Offline external seam" }; },
} });
const { buildChartIntelligenceContext, buildChartIntelligenceState, getCachedIntelligenceContext } = await import("../chartIntelligence.js");
const epoch = 1_700_000_100_000;
function fixture(symbol: string, offset = 0): ChartCandlesResponse {
  const result = runCandleTruth(Array.from({ length: 80 }, (_, i) => ({
    time: new Date(epoch + i * 300_000).toISOString(), open: 100 + offset + i / 10,
    high: 101 + offset + i / 10, low: 99 + offset + i / 10, close: 100.2 + offset + i / 10,
  })), { symbol, displaySymbol: symbol, timeframe: "M5", source: "dev", assetClass: "forex", limit: 80, now: epoch + 81 * 300_000 });
  const feedStatus: ChartFeedStatus = { symbol, displaySymbol: symbol, assetClass: "forex", source: "dev", isLive: false, lastTickTime: null,
    lastCandleTime: result.verifiedCandles.at(-1)!.closeTime, latencyMs: null, missingCandleCount: 0, duplicateCount: 0, outOfOrderCount: 0,
    invalidOhlcCount: 0, trailingIntervals: 0, stale: false, quality: "delayed", warning: "Offline fixture", aiUsable: false,
    feedReadinessState: null, message: "Offline fixture", completenessReason: null };
  return { symbol, displaySymbol: symbol, timeframe: "M5", assetClass: "forex", source: "dev", quality: "delayed", aiUsable: false, warning: "Offline fixture",
    latencyMs: null, requestedLimit: 80, candleCount: result.verifiedCandles.length, candles: result.verifiedCandles, feedStatus, truthResult: result.truthResult,
    chartTruthScore: computeChartTruthScore(result.truthResult, feedStatus), marketEvidence: { symbol, timeframe: "M5", source: "dev", sourceIdentity: "offline-a", lastClosedCandleAt: feedStatus.lastCandleTime! } };
}
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const done = new Promise<void>(r => { release = r; });
  return { entered, release, wait: () => { enter(); return done; } };
}
afterEach(() => { memoryWait = consensusWait = null; mock.restoreAll(); });

for (const seam of ["memory", "consensus"] as const) test(`captures provider facts before the ${seam} await can mutate them`, async () => {
  const symbol = `CAPTURE_${seam}`; const raw = fixture(symbol); responses.set(symbol, raw);
  const expected = structuredClone(raw); const hold = barrier();
  if (seam === "memory") memoryWait = hold.wait; else consensusWait = hold.wait;
  const pending = buildChartIntelligenceContext(symbol, "M5", 80);
  await hold.entered;
  raw.candles.at(-1)!.close = 999999;
  raw.candles[0]!.qualityFlags.push("MOCK_DATA");
  raw.candles[0]!.timeBasisEvidence!.reason = "mutated clock";
  raw.feedStatus.quality = "invalid"; raw.feedStatus.stale = true;
  raw.truthResult!.assessmentReasons.push("mutated truth");
  raw.marketEvidence!.sourceIdentity = "wrong-provider";
  hold.release(); const context = await pending;
  assert.deepEqual(context.candles, expected.candles);
  assert.deepEqual(context.feedStatus, expected.feedStatus);
  assert.deepEqual(context.truthResult, expected.truthResult);
  assert.deepEqual(context.marketEvidence, expected.marketEvidence);
  assert.equal(context.state.truthState, context.feedStatus);
  assert.equal(context.state.candleStats.lastClose, expected.candles.at(-1)!.close);
  assert.notEqual(context.candles, raw.candles);
});

test("cache and compatibility wrapper return the same coherent captured observation", async () => {
  const symbol = "CAPTURE_CACHE"; responses.set(symbol, fixture(symbol)); const before = calls.length;
  const context = await buildChartIntelligenceContext(symbol, "M5", 80);
  responses.set(symbol, fixture(symbol, 500));
  assert.equal(await buildChartIntelligenceContext(symbol, "M5", 80), context);
  assert.equal(await buildChartIntelligenceState(symbol, "M5", 80), context.state);
  assert.equal(getCachedIntelligenceContext(symbol, "M5", 80), context);
  assert.equal(context.state.latestClosedCandle, context.candles.at(-1));
  assert.equal(context.state.truthState, context.feedStatus);
  assert.equal(calls.length - before, 1);
});

test("closed-only engines exclude a forming extreme even with inconsistent isComplete true", async () => {
  const baselineSymbol = "CAPTURE_CLOSED", formingSymbol = "CAPTURE_FORMING";
  responses.set(baselineSymbol, fixture(baselineSymbol)); const raw = fixture(formingSymbol);
  raw.candles.push({ ...structuredClone(raw.candles.at(-1)!), openTime: new Date(epoch + 80 * 300_000).toISOString(), closeTime: new Date(epoch + 81 * 300_000).toISOString(),
    open: 50000, high: 100000, low: 1, close: 99999, isComplete: true, isFinal: true, isForming: true });
  responses.set(formingSymbol, raw);
  const baseline = await buildChartIntelligenceContext(baselineSymbol, "M5", 80);
  const captured = await buildChartIntelligenceContext(formingSymbol, "M5", 80);
  assert.equal(captured.candles.length, 81); // Preserve the source observation, filter analysis.
  assert.equal(captured.state.candleStats.barsAnalyzed, 80);
  assert.deepEqual(captured.state.candleStats, baseline.state.candleStats);
  assert.deepEqual(captured.state.fastFlags, baseline.state.fastFlags);
  assert.deepEqual(captured.state.marketUnderstanding.trend, baseline.state.marketUnderstanding.trend);
  assert.equal(captured.state.latestClosedCandle?.close, baseline.state.latestClosedCandle?.close);
});

test("expired cache rebuild does not rebind the previously returned state to newer facts", async () => {
  let now = epoch + 100 * 300_000; mock.method(Date, "now", () => now);
  const symbol = "CAPTURE_REBUILD"; responses.set(symbol, fixture(symbol));
  const first = await buildChartIntelligenceContext(symbol, "M5", 80); const old = structuredClone(first);
  now += 3001; assert.equal(getCachedIntelligenceContext(symbol, "M5", 80), null);
  const next = fixture(symbol, 1000); next.feedStatus.stale = true; next.marketEvidence!.sourceIdentity = "offline-b"; responses.set(symbol, next);
  const second = await buildChartIntelligenceContext(symbol, "M5", 80);
  assert.notEqual(second, first); assert.notEqual(second.state, first.state);
  assert.equal(second.state.latestClosedCandle?.close, next.candles.at(-1)!.close);
  assert.equal(second.state.truthState, second.feedStatus);
  assert.equal(second.marketEvidence?.sourceIdentity, "offline-b");
  assert.deepEqual(first, old);
  assert.equal(getCachedIntelligenceContext(symbol, "M5", 80), second);
  assert.equal(await buildChartIntelligenceState(symbol, "M5", 80), second.state);
});
