import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import {getMarketProvider,_resetMarketProviderForTests} from "../marketProvider.js";
import {normalizeCandles} from "../../data/chart/candleNormalization.js";
const keys=["TWELVEDATA_API_KEY","POLYGON_API_KEY","FINNHUB_API_KEY","ALPHA_VANTAGE_API_KEY","NEWSAPI_API_KEY"];
const oldFetch=globalThis.fetch,oldNow=Date.now;
let saved:(string|undefined)[];const NOW=Date.parse("2026-11-01T12:00:30Z");
const response=()=>({ticker:"C:EURUSD",status:"OK",resultsCount:12,results:Array.from({length:12},(_,i)=>({t:NOW-30_000-(i+1)*60_000,o:1.1,h:1.2,l:1,c:1.11,v:17,n:17}))});
beforeEach(()=>{saved=keys.map(k=>process.env[k]);keys.forEach(k=>delete process.env[k]);process.env.POLYGON_API_KEY="offline-fixture";Date.now=()=>NOW;_resetMarketProviderForTests();globalThis.fetch=async()=>Response.json(response());});
afterEach(()=>{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});Date.now=oldNow;globalThis.fetch=oldFetch;_resetMarketProviderForTests();});
const opts={symbol:"EURUSD",displaySymbol:"EUR/USD",timeframe:"M1" as const,source:"assistant_real:polygon",now:NOW};
const map=(c:any)=>({time:c.t,open:c.o,high:c.h,low:c.l,close:c.c,volume:c.v,timeBasisEvidence:c.timeBasisEvidence,priceBasisEvidence:c.priceBasisEvidence});
test("audited FX endpoint keeps original open timestamp and qualifies UTC BID without live entitlement",async()=>{
 const r=await getMarketProvider().getCandles("EURUSD","M1",12);const raw=r.candles.map(map);const n=normalizeCandles(raw,opts).candles;
 assert.equal(n[0]?.openTime,raw[0]?.time);assert.equal(r.freshness,"DELAYED");
 assert.ok(n.every(c=>c.priceBasis==="BID"&&c.timeBasisEvidence?.kind==="original_utc"));
});
for(const [name,change]of Object.entries({ticker:(r:any):unknown=>r.ticker="C:GBPUSD",status:(r:any):unknown=>r.status="ERROR",duplicate:(r:any):unknown=>r.results[1].t=r.results[0].t,invalidOHLC:(r:any):unknown=>r.results[1].h=0,invalidTime:(r:any):unknown=>r.results[1].t="2026-11-01",outOfOrder:(r:any):unknown=>r.results.reverse()}))test(`invalid ${name} response is refused wholesale`,async()=>{
 const r=response();change(r);globalThis.fetch=async()=>Response.json(r);const c=await getMarketProvider().getCandles("EURUSD","M1",12);assert.equal(c.candles.length,0);
});

import {parsePolygonFxCustomBars,POLYGON_FX_AUTHORITY} from "../polygonFxCandles.js";
import {runCandleTruth} from "../../data/chart/candleTruthEngine.js";
import {rawTrailingIntervalGap} from "../../data/chart/candleNormalization.js";
const request={ticker:"C:EURUSD",timeframe:"M1",fromMs:Date.parse("2026-10-31T00:00:00Z"),toMs:Date.parse("2026-11-01T23:59:59.999Z"),nowMs:NOW,maxBars:12};
for(const [name,change]of Object.entries({missingTicker:(r:any):unknown=>delete r.ticker,missingStatus:(r:any):unknown=>delete r.status,stringPrice:(r:any):unknown=>r.results[0].o="1.1",nonfinitePrice:(r:any):unknown=>r.results[0].o=Infinity,negativePrice:(r:any):unknown=>r.results[0].c=-1,
 timestampSeconds:(r:any):unknown=>r.results[0].t/=1000,timestampFraction:(r:any):unknown=>r.results[0].t+=0.5,unaligned:(r:any):unknown=>r.results[0].t+=1,futureOpen:(r:any):unknown=>r.results[0].t=NOW+30_000,
 outsideWindow:(r:any):unknown=>r.results.at(-1).t=request.fromMs-60_000,wrongCount:(r:any):unknown=>r.resultsCount=500,negativeVolume:(r:any):unknown=>r.results[0].v=-1,stringVolume:(r:any):unknown=>r.results[0].v="17",contradictoryCounts:(r:any):unknown=>r.results[0].n=18}))test(`strict parser rejects ${name} without salvaging other rows`,()=>{const r=response();change(r);assert.equal(parsePolygonFxCustomBars(r,request).ok,false);});
test("forming bars are omitted and no guessed full-history coverage or traded volume is minted",()=>{
 const r=response();r.results[0]!.t=NOW-30_000;const result=parsePolygonFxCustomBars({...r,next_url:"https://example.invalid/next"},request);assert.ok(result.ok);assert.equal(result.candles.length,11);assert.match(result.notes,/1 forming bars omitted/);assert.match(result.notes,/pagination is not followed/);
 const n=normalizeCandles(result.candles.map(map),opts).candles;assert.ok(n.every(c=>c.isFinal&&c.isComplete));assert.ok(n.every(c=>c.volumeEvidence?.kind==="unavailable"));
});
test("missing v remains unsupported volume, never observed zero",()=>{
 const r=response();delete (r.results[0] as any).v;delete (r.results[0] as any).n;
 const result=parsePolygonFxCustomBars(r,request);assert.ok(result.ok);assert.ok(normalizeCandles(result.candles.map(map),opts).candles.every(c=>c.volumeEvidence?.kind==="unavailable"));
});
test("in-memory candle cache preserves original endpoint evidence without refetch or freshness upgrade",async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(response());};const p=getMarketProvider();const a=await p.getCandles("EURUSD","M1",12),b=await p.getCandles("EURUSD","M1",12);assert.equal(calls,1);assert.strictEqual(a,b);
 const truth=runCandleTruth(b.candles.map(map),{...opts,assetClass:"forex",limit:12});assert.equal(truth.truthResult.priceBasis,"BID");assert.match(truth.truthResult.sourceDocumentation.timeBasisNote??"",/massive:forex-custom-bars/);assert.ok(truth.verifiedCandles.every(c=>c.timeBasisEvidence?.authority===POLYGON_FX_AUTHORITY));
 assert.equal(rawTrailingIntervalGap(b.candles.map(map),opts.source,"M1",NOW),1);
});
test("copied JSON, forged claims, context mismatch and corrected OHLC cannot reuse issued evidence",()=>{
 const parsed=parsePolygonFxCustomBars(response(),request);assert.ok(parsed.ok);const raw=parsed.candles.map(map);
 const held=(rows:any[],options:any=opts)=>{const c=normalizeCandles(rows,options).candles;assert.ok(c.every(x=>x.timeBasisEvidence?.kind==="unavailable"));assert.ok(c.every(x=>x.priceBasisEvidence?.kind==="unavailable"));};
 held(JSON.parse(JSON.stringify(raw)));held(raw.map(c=>({...c,timeBasisEvidence:{...c.timeBasisEvidence},priceBasisEvidence:{...c.priceBasisEvidence}})));
 held(raw,{...opts,symbol:"GBPUSD"});held(raw,{...opts,timeframe:"M5"});held(raw,{...opts,source:"assistant_real:twelve_data"});held(raw.map(c=>({...c,close:1.12})));
 held(raw.map(c=>({...c,time:new Date(Date.parse(c.time)-60_000).toISOString()})));held(raw.map(c=>({...c,timeBasisEvidence:undefined,priceBasisEvidence:undefined})));
});
test("audited assistant timestamps are original opens, independent of UTC authority",()=>{
 const raw=[{time:"2026-11-01T11:59:00.000Z",open:1.1,high:1.2,low:1,close:1.11,volume:0}];
 for(const source of ["assistant_real:polygon","assistant_real:twelve_data"]){const n=normalizeCandles(raw,{...opts,source}).candles[0]!;assert.equal(n.openTime,raw[0]!.time);assert.equal(n.closeTime,"2026-11-01T12:00:00.000Z");assert.equal(n.timeBasisEvidence?.kind,"unavailable");assert.equal(rawTrailingIntervalGap(raw,source,"M1",NOW),1);}
});
test("H4 request limit counts base minute aggregates and never claims output coverage",async()=>{
 globalThis.fetch=async input=>{const u=new URL(String(input));assert.match(u.pathname,/range\/4\/hour\//);assert.equal(u.searchParams.get("limit"),"2400");assert.equal(u.searchParams.get("sort"),"desc");const body={ticker:"C:EURUSD",status:"OK",results:[{t:Date.parse("2026-11-01T08:00:00Z"),o:1.1,h:1.2,l:1,c:1.11}]};return Response.json(body);};
 const r=await getMarketProvider().getCandles("EURUSD","H4",10);assert.equal(r.candles.length,1);assert.match(r.notes??"",/completeness are unverified/);assert.equal(r.freshness,"DELAYED");
});

test("invalid request context and evidence-kind swapping cannot qualify",()=>{
 for(const change of [{timeframe:"constructor"},{fromMs:request.fromMs+60_000},{toMs:request.toMs-1},{nowMs:Number.MAX_SAFE_INTEGER},{toMs:Number.MAX_SAFE_INTEGER},{ticker:"X:EURUSD"},{ticker:"C:BTCUSD"},{maxBars:201}])assert.equal(parsePolygonFxCustomBars(response(),{...request,...change}).ok,false);
 const r=parsePolygonFxCustomBars(response(),request);assert.ok(r.ok);const raw=r.candles.map(map).map(c=>({...c,timeBasisEvidence:c.priceBasisEvidence,priceBasisEvidence:c.timeBasisEvidence}));
 const n=normalizeCandles(raw as any,opts).candles;assert.ok(n.every(c=>c.timeBasisEvidence?.kind==="unavailable"&&c.priceBasisEvidence?.kind==="unavailable"));
});

test("non-midnight four-hour grid is explicitly unsupported, not relabeled",()=>{
 const result=parsePolygonFxCustomBars({ticker:"C:EURUSD",status:"OK",results:[{t:Date.parse("2026-11-01T09:00:00Z"),o:1,h:2,l:1,c:2}]},{...request,timeframe:"H4"});assert.equal(result.ok,false);if(!result.ok)assert.equal(result.reason,"UNSUPPORTED_AGGREGATE_GRID");
});

test("explicit zero quote counts contradict a quote-derived OHLC bar and refuse evidence",()=>{
 for(const change of [{v:0,n:0},{v:0,n:undefined},{v:undefined,n:0}]){const r=response();Object.assign(r.results[0]!,change);assert.equal(parsePolygonFxCustomBars(r,request).ok,false);}
});
