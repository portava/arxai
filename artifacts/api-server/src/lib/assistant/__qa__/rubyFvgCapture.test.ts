import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { RubyChartContext } from "../../data/chart/rubyChartContext.js";

let captured: RubyChartContext | null;
let independentProbeCalls = 0;
let contextCalls = 0;
const consumers: unknown[] = [];
// feedTruthCopy imports this label from the large scanner module. Keep the real
// copy rules while avoiding scanner/provider/background initialization.
mock.module("../../marketScanner.js", { namedExports: { ANALYSIS_ONLY_LABEL: "ANALYSIS ONLY — SIMULATED DATA" } });
mock.module("../../data/chart/rubyChartContext.js", { namedExports: {
  buildRubyChartContext: async () => { contextCalls++; if (!captured) throw Error("capture unavailable"); return captured; },
  buildGatedTrustLine: () => "Insufficient captured history",
  buildStructuralReadTrustLine: () => "Closed candles; live setup withheld",
} });
const requested: string[] = [];
let observations: Record<string, any> = {};
mock.module("../../data/chart/chartDataService.js", { namedExports: {
  getChartFeedStatus: async () => { independentProbeCalls++; return { aiUsable: true }; },
  getChartCandles: async (_s: string, tf: string) => { requested.push(tf); if (!observations[tf]) throw Error("missing"); return observations[tf]; },
} });
mock.module("../../data/dataManager.js", { namedExports: {
  getMarketData: async () => { throw Error("No independent primary fetch permitted"); },
} });
mock.module("../../data/chart/patternTruthService.js", { namedExports: {
  buildPatternTruthVerdict: (input: { rawCandles: unknown }) => { consumers.push(input.rawCandles); return null; },
} });
mock.module("../../data/chart/trendlineTruthService.js", { namedExports: {
  buildTrendlineTruthVerdict: (input: { rawCandles: unknown }) => { consumers.push(input.rawCandles); return null; },
} });
mock.module("../patternLearningRuntime.js", { namedExports: { applyPatternLearning: async () => { throw Error("No learning DB in this test"); } } });
mock.module("../trendlineLearningRuntime.js", { namedExports: { applyTrendlineLearning: async () => { throw Error("No learning DB in this test"); } } });
mock.module("../../data/chart/marketIntelligenceService.js", { namedExports: {
  buildMarketIntelligenceSnapshot: (ctx: RubyChartContext) => { consumers.push(ctx.candles); return null; },
} });
mock.module("../goldStrategyRead.js", { namedExports: {
  buildGoldStrategyRead: (input: { candles: unknown }) => { consumers.push(input.candles); return null; },
} });
let rawCalls = 0;
mock.module("../../data/marketDataRouter.js", { namedExports: {
  routeCandles: async (_s: string, tf: string) => { rawCalls++; return { ok: true, primaryProvider: "provider", attempts: [], candles: observations[tf]?.candles ?? [] }; },
} });
const { buildRubyStructuralRead } = await import("../rubyStructuralReadService.js");

function fixture(aiUsable: boolean): RubyChartContext {
  consumers.length = 0; contextCalls = 0; independentProbeCalls = 0;
  return {
    symbol: "EURUSD", timeframe: "M5", basis: "VERIFIED", closedBarsCount: 200,
    hasFormingCandle: false, liveDelayed: false, trustLine: "Captured feed", blockReason: null,
    state: { aiUsable, stale: !aiUsable },
    feedStatus: { aiUsable, stale: !aiUsable },
    gateOutput: { chartTruthScore: 0, chartReadScore: 0 },
    sufficiency: { status: "sufficient", freshnessVerdict: "LIVE", canShowTradeSetup: true, reasonCode: null, humanReason: "Captured history" },
    candles: Array.from({ length: 200 }, (_, i) => ({ time: new Date(Date.UTC(2026, 9, 30, 0, i * 5)).toISOString(), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i })),
    htfCandles: [], marketEvidence: null, htfFeedStatus: null, htfMarketEvidence: null, htfObservationKey: "captured-htf-observation",
  } as unknown as RubyChartContext;
}


function setup() {
 captured = fixture(true); requested.length = 0; rawCalls = 0;
 captured.marketEvidence = { symbol: "EURUSD", timeframe: "M5", source: "provider", sourceIdentity: "provider:EURUSD:M5", venueIdentity: "venue-a", lastClosedCandleAt: "2026-10-30T16:00:00.000Z" };
 observations = Object.fromEntries(["H4", "H1", "M5"].map(tf => [tf, {
   symbol: "EURUSD", timeframe: tf, source: "provider", aiUsable: true,
   feedStatus: { source: "provider", aiUsable: true, stale: false },
   marketEvidence: { ...captured!.marketEvidence, timeframe: tf, sourceIdentity: `provider:EURUSD:${tf}` },
   candles: Array.from({length: tf === "M5" ? 100 : 220}, (_,i) => ({
     openTime: new Date(Date.UTC(2026,9,30,16) - ((tf === "M5" ? 100 : 220)-i) * (tf === "H4" ? 14400000 : tf === "H1" ? 3600000 : 300000)).toISOString(), closeTime: new Date(Date.UTC(2026,9,30,16) - ((tf === "M5" ? 100 : 220)-i-1) * (tf === "H4" ? 14400000 : tf === "H1" ? 3600000 : 300000)).toISOString(),
     time: new Date(Date.UTC(2026,9,30,16) - ((tf === "M5" ? 100 : 220)-i) * (tf === "H4" ? 14400000 : tf === "H1" ? 3600000 : 300000)).toISOString(), open: 100+i, high: 102+i, low: 99+i, close:101+i,
     isComplete:true, isForming:false, timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"normalized-test-boundary",reason:null},
   })),
 }]));
}
async function read() {
 const r = await buildRubyStructuralRead({symbol:"EURUSD",timeframe:"M5"});
 assert.equal(r.readLayer,"FULL", "child cannot change primary read layer");
 return r.chartRead.fvgStrategyRead as any;
}

test("qualified FVG uses normalized timeframe reads, never the raw router", async () => {
 setup(); const r = await read();
 assert.equal(r.truth.canAnalyze,true);
 assert.deepEqual(requested.sort(),["H1","H4","M5"]); assert.equal(rawCalls,0);
});
for (const which of ["clock", "unverified-clock", "missing-clock", "stale", "missing-evidence", "other-source", "other-account", "other-symbol", "other-interval", "wrong-closed-bar", "missing-primary"]) {
 test(`FVG holds independently unqualified ${which} evidence even with FULL primary`, async () => {
  setup(); const h = observations.H1;
  if(which==="clock") {h.feedStatus.aiUsable=false; h.aiUsable=false;}
  if(which==="unverified-clock") h.candles[0].timeBasisEvidence={kind:"unavailable",basis:"BROKER_SERVER",authority:null,reason:"UTC mapping unverified"};
  if(which==="missing-clock") delete h.candles[0].timeBasisEvidence;
  if(which==="stale") h.feedStatus.stale=true;
  if(which==="missing-evidence") h.marketEvidence=null;
  if(which==="other-source") h.marketEvidence.source="different";
  if(which==="other-account") h.marketEvidence.venueIdentity="venue-b";
  if(which==="other-symbol") h.marketEvidence.symbol="GBPUSD";
  if(which==="other-interval") h.marketEvidence.timeframe="M1";
  if(which==="wrong-closed-bar") h.marketEvidence.lastClosedCandleAt="2026-10-29T17:00:00.000Z";
  if(which==="missing-primary") captured!.marketEvidence=null;
  const r = await read(); assert.equal(r.truth.canAnalyze,false); assert.equal(r.truth.canSignal,false);
  assert.equal(r.direction,"WAIT"); assert.equal(r.suggestedEntry,null); assert.equal(r.activeFvg,null);
 });
}
test("a forming bar cannot satisfy the FVG closed-history minimum", async () => {
 setup(); observations.H4.candles=observations.H4.candles.slice(0,205);
 observations.H4.candles[204].isForming=true;
 const r=await read(); assert.equal(r.truth.canAnalyze,false); assert.ok(r.truth.missingTimeframes.includes("H4"));
});


test("one failed secondary read keeps the other observed counts without granting analysis", async () => {
 setup(); delete observations.H1;
 const r=await read(); assert.equal(r.truth.canAnalyze,false);
 assert.deepEqual(r.truth.missingTimeframes,["H1"]);
 assert.ok(r.truth.unconfirmedTimeframes.includes("H1"));
});

test("unknown clock evidence is distinguished from known stale feed", async () => {
 setup(); observations.H1.feedStatus.aiUsable=false;
 const r=await read(); assert.deepEqual(r.truth.staleTimeframes,[]);
 assert.deepEqual(r.truth.unconfirmedTimeframes,["H1"]);
 assert.match(r.explanation,/unconfirmed/); assert.doesNotMatch(r.explanation,/Stale feed/);
});

test("actual MT5 normalization with unverified historical clock cannot inherit a clean FVG verdict", async () => {
 setup();
 const { normalizeCandles } = await import("../../data/chart/candleNormalization.js");
 for (const response of Object.values(observations)) {
  response.source=response.feedStatus.source=response.marketEvidence.source="mt5_broker";
 }
 captured!.marketEvidence!.source="mt5_broker";
 const raw=observations.H1.candles.map((c:any)=>({time:c.openTime,open:c.open,high:c.high,low:c.low,close:c.close}));
 observations.H1.candles=normalizeCandles(raw,{symbol:"EURUSD",displaySymbol:"EURUSD",timeframe:"H1",source:"mt5_broker",now:Date.parse("2026-10-30T16:02:00Z")}).candles;
 assert.ok(observations.H1.candles.every((c:any)=>c.timeBasisEvidence.kind==="unavailable"));
 const r=await read(); assert.equal(r.truth.canAnalyze,false); assert.deepEqual(r.truth.unconfirmedTimeframes,["H1"]);
});

test("FVG captures each completed input and primary binding before other intervals finish", async () => {
 setup();
 const {captureFvgChartInputs}=await import("../../data/chart/fvgChartContext.js");
 const reference=captured!.marketEvidence!; const before=observations.H4.candles[0].close;
 let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
 const pending=captureFvgChartInputs("EURUSD",reference,async (_symbol,tf)=>{
  if(tf==="H1") await held;
  return observations[tf];
 });
 await Promise.resolve(); await Promise.resolve();
 reference.venueIdentity="changed-primary";
 observations.H4.candles[0].close=999999;
 release();
 const result=await pending;
 assert.equal(result.h4Candles[0].close,before);
 assert.deepEqual(result.unconfirmedTimeframes,[]);
});
