import {test,mock,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
// The sole storage seam is empty: this test performs no DB, terminal or network
// reads. Provider fetch is replaced with the reviewed raw endpoint fixture.
mock.module("../../data/candleCache.js",{namedExports:{readCachedCandles:async()=>({count:0,newest:null,candles:[]}),upsertCandles:async()=>({written:0}),getCacheCoverage:async()=>null,isValidCacheOhlc:()=>true}});
const {getMarketProvider,_resetMarketProviderForTests}=await import("../marketProvider.js");
const {routeCandles,routeCandlesForDecision}=await import("../../data/marketDataRouter.js");
const {__resetMt5ProviderStore}=await import("../../data/providers/mt5Provider.js");
const {runCandleTruth}=await import("../../data/chart/candleTruthEngine.js");
const {scannerSourceIdentity}=await import("../../scannerInputIntegrity.js");
// Runtime import exercises the real frontend capture without pulling its Vite
// path aliases into the independent API TypeScript project.
const chartCapturePath="../../../../../trading-dashboard/src/lib/chart-engine/chartResearchEvidence.ts";
const {captureChartResearchWindow}=await import(chartCapturePath);
const NOW=Date.parse("2026-11-01T12:00:30Z"),originalFetch=globalThis.fetch,originalNow=Date.now;
const keys=["TWELVEDATA_API_KEY","POLYGON_API_KEY","FINNHUB_API_KEY","ALPHA_VANTAGE_API_KEY","NEWSAPI_API_KEY","DERIV_API_TOKEN","DERIV_APP_ID"];
let saved:(string|undefined)[];
const body=()=>({ticker:"C:EURUSD",status:"OK",resultsCount:20,results:Array.from({length:20},(_,i)=>({t:NOW-30_000-(i+1)*60_000,o:1.1,h:1.101,l:1.099,c:1.1001,v:17,n:17}))});
beforeEach(()=>{saved=keys.map(k=>process.env[k]);keys.forEach(k=>delete process.env[k]);process.env.POLYGON_API_KEY="offline-fixture";Date.now=()=>NOW;globalThis.fetch=async input=>{assert.match(String(input),/api\.polygon\.io\/v2\/aggs\/ticker\/C%3AEURUSD\/range\/1\/minute\//);return Response.json(body());};_resetMarketProviderForTests();__resetMt5ProviderStore();});
afterEach(()=>{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});Date.now=originalNow;globalThis.fetch=originalFetch;_resetMarketProviderForTests();__resetMt5ProviderStore();});
async function pipeline(){
 const routed=await routeCandles("EURUSD","M1",20);assert.ok(routed.ok);assert.equal(routed.primaryProvider,"assistant_real:polygon");assert.equal(routed.provenance?.delayed,true);assert.equal(routed.provenance?.bridgeConnectionId,null);
 const truth=runCandleTruth(routed.candles,{symbol:"EURUSD",displaySymbol:"EUR/USD",timeframe:"M1",source:routed.primaryProvider,assetClass:"forex",now:NOW,limit:20});
 const candles=truth.verifiedCandles;
 const data={symbol:"EURUSD",timeframe:"M1",source:routed.primaryProvider,quality:"clean",candles,feedStatus:{source:routed.primaryProvider},marketEvidence:{symbol:"EURUSD",timeframe:"M1",source:routed.primaryProvider,sourceIdentity:scannerSourceIdentity(routed),lastClosedCandleAt:candles.at(-1)!.closeTime}} as any;
 const visibleBars=candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close}));
 return {routed,truth,data,visibleBars,expected:{symbol:"EURUSD",timeframe:"M1"},asOfMs:NOW};
}
test("actual provider -> memory cache -> router -> Truth -> chart capture preserves original UTC BID observations",async()=>{
 const f=await pipeline();const captured=captureChartResearchWindow(f);assert.equal(captured.status,"ready",captured.reason??"");assert.equal(captured.snapshot?.researchInput.priceBasis,"BID");assert.equal(captured.snapshot?.researchInput.source.kind,"historical_unattested");assert.equal(captured.snapshot?.coverage.closedBars,20);
 assert.equal(captured.snapshot?.researchInput.bars[0]!.openTimeMs,body().results.at(-1)!.t);
 const again=await getMarketProvider().getCandles("EURUSD","M1",20);assert.strictEqual(again.candles[0]!.timeBasisEvidence,f.routed.candles[0]!.timeBasisEvidence);
 const decision=await routeCandlesForDecision("EURUSD","M1",{limit:20});assert.equal(decision.ok,false,"display history never enters broker-only execution gate");
});
test("requested window larger than observed response is unavailable, never silently truncated",async()=>{const f=await pipeline();assert.equal(captureChartResearchWindow({...f,requestedWindow:{fromInclusiveMs:NOW-30_000-100*60_000,toExclusiveMs:NOW-30_000}}).status,"unavailable");});
for(const kind of ["missing","mixed","withdrawn","price"] as const)test(`normalized ${kind} original evidence cannot be used for research`,async()=>{
 const f=await pipeline();if(kind==="missing")delete f.data.candles[0].timeBasisEvidence;
 if(kind==="mixed")f.data.candles[0].timeBasisEvidence={...f.data.candles[0].timeBasisEvidence,authority:"other-original-authority"};
 if(kind==="withdrawn")f.data.candles[0].timeBasisEvidence={kind:"unavailable",basis:null,authority:null,reason:"withdrawn"};
 if(kind==="price")f.data.candles[0].priceBasisEvidence={kind:"unavailable",basis:null,reason:"withdrawn"};
 assert.equal(captureChartResearchWindow(f).status,"unavailable");
});
test("persisted numeric/copy metadata cannot reacquire authority through same router label",async()=>{const f=await pipeline();const copied=JSON.parse(JSON.stringify(f.routed.candles));const result=runCandleTruth(copied,{symbol:"EURUSD",displaySymbol:"EUR/USD",timeframe:"M1",source:"assistant_real:polygon",assetClass:"forex",now:NOW,limit:20});assert.ok(result.verifiedCandles.every(c=>c.priceBasis==="UNKNOWN"&&c.timeBasisEvidence?.kind==="unavailable"));});
