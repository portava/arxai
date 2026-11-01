import {test,mock,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
mock.module("../../data/candleCache.js",{namedExports:{readCachedCandles:async()=>({count:0,newest:null,candles:[]}),upsertCandles:async()=>({written:0}),getCacheCoverage:async()=>null,isValidCacheOhlc:()=>true}});
const {getMarketProvider,_resetMarketProviderForTests}=await import("../marketProvider.js");
const {routeCandles,routeCandlesForDecision}=await import("../../data/marketDataRouter.js");
const {__resetMt5ProviderStore}=await import("../../data/providers/mt5Provider.js");
const {runCandleTruth}=await import("../../data/chart/candleTruthEngine.js");
const NOW=Date.parse("2026-10-30T16:00:30Z"),originalFetch=globalThis.fetch,originalNow=Date.now;
const keys=["TWELVEDATA_API_KEY","POLYGON_API_KEY","FINNHUB_API_KEY","ALPHA_VANTAGE_API_KEY","NEWSAPI_API_KEY","DERIV_API_TOKEN","DERIV_APP_ID"];
let saved:(string|undefined)[],calls=0;
function body(){return {status:"ok",meta:{symbol:"AAPL",interval:"1min",exchange_timezone:"America/New_York",type:"Common Stock",exchange:"NASDAQ",mic_code:"XNAS",currency:"USD"},values:Array.from({length:20},(_,i)=>({datetime:new Date(NOW-30_000-(i+1)*60_000).toISOString().replace("T"," ").slice(0,19),open:"100",high:"102",low:"99",close:"101",volume:String(200+i)}))};}
beforeEach(()=>{saved=keys.map(k=>process.env[k]);keys.forEach(k=>delete process.env[k]);process.env.TWELVEDATA_API_KEY="offline-fixture";Date.now=()=>NOW;calls=0;globalThis.fetch=async input=>{calls++;const url=new URL(String(input));assert.equal(url.origin,"https://api.twelvedata.com");assert.equal(url.pathname,"/time_series");assert.equal(url.searchParams.get("symbol"),"AAPL");assert.equal(url.searchParams.get("type"),"Common Stock");assert.equal(url.searchParams.get("adjust"),"none");assert.equal(url.searchParams.get("prepost"),"false");assert.equal(url.searchParams.get("timezone"),"UTC");return Response.json(body());};_resetMarketProviderForTests();__resetMt5ProviderStore();});
afterEach(()=>{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});Date.now=originalNow;globalThis.fetch=originalFetch;_resetMarketProviderForTests();__resetMt5ProviderStore();});
const truth=(candles:any[],symbol="AAPL",timeframe:Parameters<typeof runCandleTruth>[1]["timeframe"]="M1",source="assistant_real:twelve_data")=>runCandleTruth(candles,{symbol,displaySymbol:symbol,timeframe,source,assetClass:"stocks",now:NOW,limit:20}).verifiedCandles;
test("actual stock request -> reference cache -> router -> Truth qualifies original trade units without execution authority",async()=>{
 const routed=await routeCandles("AAPL","M1",20);assert.equal(routed.ok,true);assert.equal(routed.primaryProvider,"assistant_real:twelve_data");assert.equal(routed.provenance?.delayed,true);assert.equal(routed.provenance?.bridgeConnectionId,null);
 const bars=truth(routed.candles);assert.equal(bars.length,20);assert.ok(bars.every(c=>c.volumeEvidence?.kind==="real_volume" && c.volumeEvidence.quantity===c.volume && c.timeBasisEvidence?.kind==="original_utc" && c.priceBasisEvidence?.kind==="unavailable"));
 assert.ok(bars.every(c=>!("originalVolumeSeriesIdentity" in c)),"internal listing key is not API authority");
 const cached=await getMarketProvider().getCandles("AAPL","M1",20);assert.equal(calls,1);assert.strictEqual(cached.candles[0]!.volumeEvidence,routed.candles[0]!.volumeEvidence);
 const decision=await routeCandlesForDecision("AAPL","M1",{limit:20});assert.equal(decision.ok,false);
});
for(const mutation of ["serialize","copy evidence","OHLC","quantity","timestamp","symbol","timeframe","source","remove volume","remove listing","replace listing","swap kind"] as const)test(`withdraws original stock authority after ${mutation}`,async()=>{
 const routed=await routeCandles("AAPL","M1",20);let c:any[]=routed.candles.map(c=>({...c}));let symbol="AAPL",source="assistant_real:twelve_data";let tf:Parameters<typeof runCandleTruth>[1]["timeframe"]="M1";
 if(mutation==="serialize")c=JSON.parse(JSON.stringify(c));
 if(mutation==="copy evidence")c[0].volumeEvidence={...c[0].volumeEvidence};
 if(mutation==="OHLC")c[0].close=100.5;
 if(mutation==="quantity")c[0].volume++;
 if(mutation==="timestamp")c[0].time=new Date(Date.parse(c[0].time)-60_000).toISOString();
 if(mutation==="symbol")symbol="MSFT";
 if(mutation==="timeframe")tf="M5";
 if(mutation==="source")source="mt5_broker";
 if(mutation==="remove volume")delete c[0].volumeEvidence;
 if(mutation==="remove listing")delete c[0].originalVolumeSeriesIdentity;
 if(mutation==="replace listing")c[0].originalVolumeSeriesIdentity="f".repeat(64);
 if(mutation==="swap kind")c[0].volumeEvidence=c[0].timeBasisEvidence;
 const bars=truth(c,symbol,tf,source);assert.ok(bars.length);assert.equal(bars[0]!.volumeEvidence?.kind,"unavailable");
});
test("provider-returned listing metadata cannot claim volume through arbitrary raw labels",()=>{const raw=body().values.map(r=>({time:r.datetime.replace(" ","T")+".000Z",open:100,high:102,low:99,close:101,volume:200,volumeEvidence:{kind:"real_volume",quantity:200,unit:"provider_trade_units",reason:null,authority:"twelve-data:time-series:common-stock:regular-unadjusted:v1",seriesIdentity:"a".repeat(64)}}));assert.ok(truth(raw).every(c=>c.volumeEvidence?.kind==="unavailable"));});
