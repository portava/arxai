import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { closedAnalysisWindowIdentity } from "../capturedAnalysisCandles.js";

const feed = { source: "captured_provider", aiUsable: true, stale: false, quality: "clean" };
const closed = { symbol: "EURUSD", timeframe: "M5", openTime: "2026-11-01T10:00:00.000Z", closeTime: "2026-11-01T10:05:00.000Z", open: 99, high: 101, low: 98, close: 100, volume: 0, volumeEvidence: { kind: "unavailable", quantity: null, unit: null, reason: "No reported volume" }, isComplete: true, isForming: false };
const forming = { ...closed, openTime: "2026-11-01T10:05:00.000Z", closeTime: "2026-11-01T10:10:00.000Z", close: 999, isComplete: false, isForming: true };
const state = { symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M5", aiUsable: true, stale: false, currentCandle: forming, candleStats: { barsAnalyzed: 1 }, truthState: feed, gateOutput: { confidentReadAllowed: false, autonomousChartActionAllowed: false, tradeConfirmationAllowed: false, primaryBlockReason: "Unmeasured" }, brokerAlignment: {}, chartTruthScore: {} };
const capture = { state, candles: [closed, forming], feedStatus: feed, truthResult: null, marketEvidence: { symbol: "EURUSD", timeframe: "M5", source: "captured_provider", sourceIdentity: "a".repeat(64), venueIdentity: "v".repeat(64), lastClosedCandleAt: closed.closeTime } };
let rawCalls = 0;
let higher: any = { candles: [], feedStatus: { ...feed, aiUsable: false }, marketEvidence: null };
let higherFails = false;
const higherRequests: unknown[][] = [];
let alignedContext: unknown;
let contextWait: Promise<void> | null = null;
mock.module("../chartIntelligence.js", { namedExports: {
  buildChartIntelligenceState: async () => state,
  buildChartIntelligenceContext: async () => { await contextWait; return capture; },
} });
mock.module("../../dataManager.js", { namedExports: { getMarketData: async () => { rawCalls++; return [{ time: closed.openTime, open: 899, high: 901, low: 898, close: 900 }]; } } });
mock.module("../chartDataService.js", { namedExports: { getChartCandles: async (...args: unknown[]) => { higherRequests.push(args); if (higherFails) throw Error("No HTF feed"); return higher; } } });
mock.module("../userBrokerAlignment.js", { namedExports: { enrichStateWithUserBrokerQuote: async (s: unknown, args: { context: unknown }) => { alignedContext = args.context; return s; } } });
mock.module("../chartHandshake.js", { namedExports: { buildChartHandshake: () => ({ overall: "UNKNOWN", sourceOverall: "UNKNOWN" }) } });
mock.module("../brokerPriceAlignment.js", { namedExports: { mirrorTrustSegment: () => "Mirror unmeasured" } });
mock.module("../chartSufficiency.js", { namedExports: { evaluateSufficiencyFromChartState: () => ({ status: "insufficient", humanReason: "Too few closed bars" }) } });
mock.module("../../providers/derivProvider.js", { namedExports: { hasRecentDerivTickFor: () => false } });
const { buildRubyChartContext } = await import("../rubyChartContext.js");

test("assessment uses the captured primary candles, never a later provider result", async () => {
  const ctx = await buildRubyChartContext("EURUSD", "M5", 200);
  assert.deepEqual(ctx.candles.map(c => c.close), [100]);
  assert.equal(rawCalls, 0);
  assert.equal(ctx.closedBarsCount, ctx.candles.length);
});
test("captured feed judgment and source evidence travel with the assessment candles", async () => {
  const ctx = await buildRubyChartContext("EURUSD", "M5", 200);
  assert.deepEqual((ctx as any).feedStatus, feed);
  assert.deepEqual((ctx as any).marketEvidence, capture.marketEvidence);
});
test("normalization retains open-time basis and never fabricates unavailable volume", async () => {
  const ctx = await buildRubyChartContext("EURUSD", "M5", 200);
  assert.equal(ctx.candles[0]!.time, closed.openTime);
  assert.equal(ctx.candles[0]!.volume, undefined);
  assert.deepEqual(ctx.candles[0]!.volumeEvidence, closed.volumeEvidence);
});

function qualifiedHigher(): any {
  const bar = { ...closed, timeframe: "H1", openTime: "2026-11-01T09:00:00.000Z", closeTime: "2026-11-01T10:00:00.000Z", open: 399, high: 401, low: 398, close: 400,
    timeBasisEvidence: { kind: "original_utc", basis: "UTC", authority: "test-provider", reason: null } };
  const candles = [bar, { ...forming, timeframe: "H1", isComplete: true }];
  return { symbol: "EURUSD", timeframe: "H1", source: feed.source, aiUsable: true, candles, feedStatus: { ...feed },
    marketEvidence: { ...capture.marketEvidence, sourceIdentity: "b".repeat(64), timeframe: "H1", lastClosedCandleAt: bar.closeTime, closedWindowIdentity: closedAnalysisWindowIdentity(candles as any) } };
}

test("qualified higher timeframe owns its closed observation without replacing primary status", async () => {
  higher = qualifiedHigher();
  const ctx = await buildRubyChartContext("EURUSD", "M5", 200, { userId: 7 });
  assert.equal(alignedContext, capture);
  assert.deepEqual(ctx.candles.map(c => c.close), [100]);
  assert.deepEqual(ctx.htfCandles.map(c => c.close), [400]);
  assert.equal(ctx.feedStatus.source, "captured_provider");
  assert.equal(ctx.htfMarketEvidence?.sourceIdentity, "b".repeat(64));
  assert.deepEqual(higherRequests.at(-1), ["EURUSD", "H1", 120]);
  higher.candles[0].close = 500;
  higher.feedStatus.source = "changed-after-return";
  assert.equal(ctx.htfCandles[0]!.close, 400);
  assert.equal(ctx.htfFeedStatus?.source, feed.source);
});

for (const [name, change] of Object.entries<Record<string, (h: any) => void>[string]>({
  "different provider": h => { h.source = h.feedStatus.source = h.marketEvidence.source = "another"; },
  "different account": h => { h.marketEvidence.venueIdentity = "another-account"; },
  "missing venue": h => { delete h.marketEvidence.venueIdentity; },
  "missing provenance": h => { h.marketEvidence = null; },
  "wrong market": h => { h.symbol = h.marketEvidence.symbol = "GBPUSD"; },
  "wrong interval": h => { h.timeframe = h.marketEvidence.timeframe = "M15"; },
  "wrong bar market": h => { h.candles[0].symbol = "GBPUSD"; },
  "wrong bar interval": h => { h.candles[0].timeframe = "M15"; },
  "wrong closed time": h => { h.marketEvidence.lastClosedCandleAt = closed.closeTime; },
  "revised history with old identity": h => { h.candles[0].close = 399; },
  "missing window identity": h => { delete h.marketEvidence.closedWindowIdentity; },
  "unqualified UTC": h => { delete h.candles[0].timeBasisEvidence; },
  "conflicting feed source": h => { h.feedStatus.source = "another"; },
  "top-level unusable": h => { h.aiUsable = false; },
})) {
  test(`higher-timeframe ${name} cannot supply bias`, async () => {
    higherFails = false;
    higher = qualifiedHigher(); change(higher);
    const ctx = await buildRubyChartContext("EURUSD", "M5", 200);
    assert.deepEqual(ctx.htfCandles, []);
    assert.deepEqual(ctx.candles.map(c => c.close), [100]);
    assert.deepEqual(ctx.htfMarketEvidence, higher.marketEvidence);
  });
}

test("failed higher timeframe never substitutes primary bars", async () => {
  higherFails = true;
  const failed = await buildRubyChartContext("EURUSD", "M5", 200);
  assert.deepEqual(failed.htfCandles, []);
  assert.equal(failed.htfFeedStatus, null);
  assert.deepEqual(failed.candles.map(c => c.close), [100]);

});

test("unconfirmed higher-timeframe bars cannot become unlabelled bias or pivot inputs", async () => {
  higherFails = false;
  for (const status of [{ ...feed, aiUsable: false }, { ...feed, stale: true }]) {
    higher = { candles: [closed], feedStatus: status, marketEvidence: null };
    const ctx = await buildRubyChartContext("EURUSD", "M5", 200);
    assert.deepEqual(ctx.htfCandles, []);
    assert.equal(ctx.htfTimeframe, "H1");
    assert.deepEqual(ctx.htfFeedStatus, status);
    assert.deepEqual(ctx.candles.map(c => c.close), [100]);
  }
});

test("independent HTF acquisition starts before the primary build finishes", async () => {
  let release!: () => void;
  contextWait = new Promise<void>(resolve => { release = resolve; });
  const before = higherRequests.length;
  const pending = buildRubyChartContext("EURUSD", "M5", 200);
  try {
    assert.equal(higherRequests.length, before + 1);
    assert.deepEqual(higherRequests.at(-1), ["EURUSD", "H1", 120]);
  } finally { release(); contextWait = null; }
  await pending;
});
