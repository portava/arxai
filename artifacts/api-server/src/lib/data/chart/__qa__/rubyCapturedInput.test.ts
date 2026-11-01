import { test, mock } from "node:test";
import assert from "node:assert/strict";

const feed = { source: "captured_provider", aiUsable: true, stale: false, quality: "clean" };
const closed = { symbol: "EURUSD", timeframe: "M5", openTime: "2026-11-01T10:00:00.000Z", closeTime: "2026-11-01T10:05:00.000Z", open: 99, high: 101, low: 98, close: 100, volume: 0, volumeEvidence: { kind: "unavailable", quantity: null, unit: null, reason: "No reported volume" }, isComplete: true, isForming: false };
const forming = { ...closed, openTime: "2026-11-01T10:05:00.000Z", closeTime: "2026-11-01T10:10:00.000Z", close: 999, isComplete: false, isForming: true };
const state = { symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M5", aiUsable: true, stale: false, currentCandle: forming, candleStats: { barsAnalyzed: 1 }, truthState: feed, gateOutput: { confidentReadAllowed: false, autonomousChartActionAllowed: false, tradeConfirmationAllowed: false, primaryBlockReason: "Unmeasured" }, brokerAlignment: {}, chartTruthScore: {} };
const capture = { state, candles: [closed, forming], feedStatus: feed, truthResult: null, marketEvidence: { symbol: "EURUSD", timeframe: "M5", source: "captured_provider", sourceIdentity: "A", lastClosedCandleAt: closed.closeTime } };
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

test("higher timeframe has its own closed-only observation and does not replace primary status", async () => {
  higher = { candles: [{ ...closed, close: 400 }, { ...forming, isComplete: true }], feedStatus: { ...feed, source: "other", aiUsable: true }, marketEvidence: { ...capture.marketEvidence, sourceIdentity: "B", timeframe: "H1" } };
  const ctx = await buildRubyChartContext("EURUSD", "M5", 200, { userId: 7 });
  assert.equal(alignedContext, capture);
  assert.deepEqual(ctx.candles.map(c => c.close), [100]);
  assert.deepEqual(ctx.htfCandles.map(c => c.close), [400]);
  assert.equal(ctx.feedStatus.source, "captured_provider");
  assert.equal(ctx.htfFeedStatus?.source, "other");
  assert.equal(ctx.htfMarketEvidence?.sourceIdentity, "B");
  assert.deepEqual(higherRequests.at(-1), ["EURUSD", "H1", 120]);
  higher.candles[0].close = 500;
  higher.feedStatus.source = "changed-after-return";
  assert.equal(ctx.htfCandles[0]!.close, 400);
  assert.equal(ctx.htfFeedStatus?.source, "other");
});

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
