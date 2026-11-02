import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { RubyChartContext } from "../../data/chart/rubyChartContext.js";

let captured: RubyChartContext | null;
let independentProbeCalls = 0;
let contextCalls = 0;
const consumers: unknown[] = [];
const patternContexts: { source?: string | null; timestampConvention?: string }[] = [];
// feedTruthCopy imports this label from the large scanner module. Keep the real
// copy rules while avoiding scanner/provider/background initialization.
mock.module("../../marketScanner.js", { namedExports: { ANALYSIS_ONLY_LABEL: "ANALYSIS ONLY — SIMULATED DATA" } });
mock.module("../../data/chart/rubyChartContext.js", { namedExports: {
  buildRubyChartContext: async () => { contextCalls++; if (!captured) throw Error("capture unavailable"); return captured; },
  buildGatedTrustLine: () => "Insufficient captured history",
  buildStructuralReadTrustLine: () => "Closed candles; live setup withheld",
} });
mock.module("../../data/chart/chartDataService.js", { namedExports: {
  getChartCandles: async () => { throw Error("No secondary data in primary-capture test"); },
  getChartFeedStatus: async () => { independentProbeCalls++; return { aiUsable: true }; },
} });
mock.module("../../data/dataManager.js", { namedExports: {
  getMarketData: async () => { throw Error("No independent primary fetch permitted"); },
} });
mock.module("../../data/chart/patternTruthService.js", { namedExports: {
  buildPatternTruthVerdict: (input: { rawCandles: unknown; source?: string | null; timestampConvention?: string }) => { consumers.push(input.rawCandles); patternContexts.push(input); return null; },
} });
mock.module("../../data/chart/trendlineTruthService.js", { namedExports: {
  buildTrendlineTruthVerdict: (input: { rawCandles: unknown; source?: string | null; timestampConvention?: string }) => { consumers.push(input.rawCandles); patternContexts.push(input); return null; },
} });
mock.module("../patternLearningRuntime.js", { namedExports: { applyPatternLearning: async () => { throw Error("No learning DB in this test"); } } });
mock.module("../trendlineLearningRuntime.js", { namedExports: { applyTrendlineLearning: async () => { throw Error("No learning DB in this test"); } } });
mock.module("../../data/chart/marketIntelligenceService.js", { namedExports: {
  buildMarketIntelligenceSnapshot: (ctx: RubyChartContext) => { consumers.push(ctx.candles); return null; },
} });
mock.module("../goldStrategyRead.js", { namedExports: {
  buildGoldStrategyRead: (input: { candles: unknown }) => { consumers.push(input.candles); return null; },
} });
mock.module("../../data/marketDataRouter.js", { namedExports: {
  routeCandles: async () => ({ ok: false, primaryProvider: null, attempts: [], candles: [] }),
} });
mock.module("../fvgStrategyRead.js", { namedExports: {
  buildFvgStrategyRead: () => null, withholdFvgLevels: () => null,
} });
const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");

function fixture(aiUsable: boolean): RubyChartContext {
  consumers.length = 0; patternContexts.length = 0; contextCalls = 0; independentProbeCalls = 0;
  return {
    symbol: "EURUSD", timeframe: "M5", basis: "VERIFIED", closedBarsCount: 200,
    hasFormingCandle: false, liveDelayed: false, trustLine: "Captured feed", blockReason: null,
    state: { aiUsable, stale: !aiUsable },
    feedStatus: { aiUsable, stale: !aiUsable },
    gateOutput: { chartTruthScore: 0, chartReadScore: 0 },
    sufficiency: { status: "sufficient", freshnessVerdict: "LIVE", canShowTradeSetup: true, reasonCode: null, humanReason: "Captured history" },
    candles: Array.from({ length: 200 }, (_, i) => ({ time: new Date(Date.UTC(2026, 9, 30, 0, i * 5)).toISOString(), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i })),
    htfCandles: [], marketEvidence: null, htfFeedStatus: null, htfMarketEvidence: null,
  } as unknown as RubyChartContext;
}

test("an independent clean probe cannot upgrade a limited captured primary feed", async () => {
  captured = fixture(false);
  const result = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M5" });
  assert.equal(result.readLayer, "STRUCTURAL_ONLY");
  assert.equal(result.feedUnconfirmed, true);
  assert.equal(independentProbeCalls, 0);
  assert.equal(contextCalls, 1);
  assert.equal(consumers.length, 4);
  assert.ok(consumers.every(candles => candles === captured!.candles));
});

test("captured usable feed can support the existing display layer without another feed probe", async () => {
  captured = fixture(true);
  const result = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M5" });
  assert.equal(result.readLayer, "FULL");
  assert.equal(result.feedUnconfirmed, false);
  assert.equal(independentProbeCalls, 0);
  assert.equal(contextCalls, 1);
  assert.ok(consumers.every(candles => candles === captured!.candles));
});

test("a client's negative observation still withholds live setup on a usable capture", async () => {
  captured = fixture(true);
  const result = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M5", clientFeedUnconfirmed: true });
  assert.equal(result.readLayer, "STRUCTURAL_ONLY");
  assert.equal(result.feedUnconfirmed, true);
  assert.equal(result.chartRead.canShowLiveTradeSetup, false);
});

test("missing captured feed status cannot be replaced by an independent clean probe", async () => {
  captured = fixture(true);
  delete (captured as Partial<RubyChartContext>).feedStatus;
  const result = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M5" });
  assert.equal(result.readLayer, "STRUCTURAL_ONLY");
  assert.equal(independentProbeCalls, 0);
});

test("capture failure yields insufficient evidence without consulting another feed", async () => {
  fixture(true); captured = null;
  const result = await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M5" });
  assert.equal(result.readLayer, "INSUFFICIENT");
  assert.equal(result.feedUnconfirmed, true);
  assert.equal(result.shouldRecordReadDecision, false);
  assert.equal(independentProbeCalls, 0);
  assert.equal(consumers.length, 0);
});

for (const full of [true, false]) {
  for (const source of ["mt5_broker", "deriv_public", "assistant_real:legacy", null]) {
    test(`pattern children preserve captured source and normalized-open convention (${full ? "full" : "restricted"}, ${source})`, async () => {
      captured = fixture(full);
      captured.feedStatus.source = source;
      // A different state label must not replace the primary captured feed.
      captured.state.truthState = { ...captured.feedStatus, source: "unrelated-state-provider" };
      await buildRubyStructuralRead({ symbol: "EURUSD", timeframe: "M5" });
      assert.equal(patternContexts.length, 2);
      assert.ok(patternContexts.every(input => input.source === source));
      assert.ok(patternContexts.every(input => input.timestampConvention === "open"));
      assert.equal(independentProbeCalls, 0);
    });
  }
}

for (const full of [true,false]) test(`response carries captured evidence, not a later observation (${full})`,async()=>{
  captured=fixture(full);
  const evidence={symbol:"EURUSD",timeframe:"M5",source:"deriv_public",sourceIdentity:"a".repeat(64),closedWindowIdentity:"c".repeat(64),lastClosedCandleAt:"2026-01-01T00:00:00.000Z"};
  captured.marketEvidence=evidence;
  const result=await buildRubyStructuralRead({symbol:"EURUSD",timeframe:"5m",userId:7});
  assert.deepEqual(result.chartRead.assessmentEvidence,{...evidence,userId:7});
  evidence.sourceIdentity="b".repeat(64);
  evidence.closedWindowIdentity="d".repeat(64);
  assert.equal((result.chartRead.assessmentEvidence as typeof evidence).closedWindowIdentity,"c".repeat(64));
  assert.equal((result.chartRead.assessmentEvidence as typeof evidence).sourceIdentity,"a".repeat(64));
  assert.equal(contextCalls,1);assert.equal(independentProbeCalls,0);
});
test("missing captured identity is not invented from requested market",async()=>{
  captured=fixture(true);
  const result=await buildRubyStructuralRead({symbol:"EURUSD",timeframe:"M5",userId:7});
  assert.equal(result.chartRead.assessmentEvidence,null);
});
