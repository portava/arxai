import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getMarketProvider, _resetMarketProviderForTests } from "../marketProvider.js";
import { parseTwelveDataIntradayCandles } from "../twelveDataCandles.js";
const keys=["TWELVEDATA_API_KEY","POLYGON_API_KEY","FINNHUB_API_KEY","ALPHA_VANTAGE_API_KEY","NEWSAPI_API_KEY"];
const oldFetch=globalThis.fetch,oldNow=Date.now;
let saved:Array<string|undefined>;
const NOW=Date.parse("2026-11-01T12:00:05Z");
function fixture(){return {status:"ok",meta:{symbol:"EUR/USD",interval:"1min",exchange_timezone:"Australia/Sydney",type:"Physical Currency"},values:[
 {datetime:"2026-11-01 12:00:00",open:"1.10",high:"1.12",low:"1.09",close:"1.11"},
 {datetime:"2026-11-01 11:59:00",open:"1.09",high:"1.11",low:"1.08",close:"1.10"},
]};}
beforeEach(()=>{saved=keys.map(k=>process.env[k]);keys.forEach(k=>delete process.env[k]);process.env.TWELVEDATA_API_KEY="offline-fixture";Date.now=()=>NOW;_resetMarketProviderForTests();globalThis.fetch=async()=>{throw Error("Unexpected network request");};});
afterEach(()=>{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});globalThis.fetch=oldFetch;Date.now=oldNow;_resetMarketProviderForTests();});
async function read(payload:unknown){globalThis.fetch=async()=>Response.json(payload);return getMarketProvider().getCandles("EURUSD","M1",10);}
test("requests explicit UTC intraday output and preserves original bar-open dates",async()=>{
 let url:URL|undefined;globalThis.fetch=async input=>{url=new URL(String(input));return Response.json(fixture());};
 const result=await getMarketProvider().getCandles("EURUSD","M1",10);
 assert.equal(url?.searchParams.get("timezone"),"UTC");assert.equal(url?.searchParams.get("order"),"desc");
 assert.deepEqual(result.candles.map(c=>c.t),["2026-11-01T11:59:00.000Z","2026-11-01T12:00:00.000Z"]);
 assert.ok(result.candles.every(c=>!("timeBasisEvidence" in c)&&!("priceBasisEvidence" in c)));
});
for(const [label,mutate] of [
 ["missing metadata",(p:any)=>delete p.meta],
 ["wrong symbol",(p:any)=>p.meta.symbol="GBP/USD"],
 ["wrong interval",(p:any)=>p.meta.interval="5min"],
 ["missing exchange clock",(p:any)=>delete p.meta.exchange_timezone],
 ["invalid exchange clock",(p:any)=>p.meta.exchange_timezone="not/a/clock"],
 ["conflicting output clock",(p:any)=>p.meta.timezone="Australia/Sydney"],
 ["missing status",(p:any)=>delete p.status],
 ["invalid calendar date",(p:any)=>p.values[0].datetime="2026-02-30 12:00:00"],
 ["explicit nonUTC suffix",(p:any)=>p.values[0].datetime="2026-11-01T12:00:00+11:00"],
 ["future time",(p:any)=>p.values[0].datetime="2026-11-02 12:00:00"],
 ["date only",(p:any)=>p.values[0].datetime="2026-11-01"],
 ["duplicate time",(p:any)=>p.values[0].datetime=p.values[1].datetime],
 ["ascending response",(p:any)=>p.values.reverse()],
 ["invalid OHLC",(p:any)=>p.values[0].high="1.0"],
 ["null price",(p:any)=>p.values[0].open=null],
] as const){test(`refuses ${label} without partial candles`,async()=>{const p=fixture();mutate(p);const result=await read(p);assert.equal(result.candles.length,0);assert.equal(result.asOf,null);assert.equal(result.freshness,"UNAVAILABLE");});}
test("daily UTC requests are unsupported because provider ignores timezone at daily intervals",async()=>{let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(fixture());};const result=await getMarketProvider().getCandles("EURUSD","D1",10);assert.equal(calls,0);assert.equal(result.candles.length,0);assert.equal(result.freshness,"UNAVAILABLE");});
test("intraday New York exchange clock is metadata, not the explicitly requested UTC output zone",async()=>{const p=fixture();p.meta.exchange_timezone="America/New_York";const result=await read(p);assert.equal(result.candles[0]?.t,"2026-11-01T11:59:00.000Z");});
test("old verified timestamps remain delayed rather than turning into current data",async()=>{const p=fixture();p.values.forEach(r=>r.datetime=r.datetime.replace("2026-11-01","2026-10-30"));const result=await read(p);assert.equal(result.freshness,"DELAYED");assert.equal(result.asOf,"2026-10-30T12:00:00.000Z");});

const request={symbol:"EUR/USD",interval:"1min",limit:10,timezone:"UTC",order:"desc"} as const;
test("parser refuses forged request clocks and unsupported daily intervals",()=>{
 for(const patch of [{timezone:"Exchange"},{order:"asc"},{interval:"1day"},{interval:"constructor"},{limit:NaN},{limit:201}]){
  assert.equal(parseTwelveDataIntradayCandles(fixture(),{...request,...patch} as typeof request,NOW).ok,false);
 }
});
for(const interval of ["1min","5min","15min","30min","1h","4h"]){test(`accepts explicit UTC ${interval} without shifting exchange times`,()=>{
 const p=fixture();p.meta.interval=interval;
 const minutes:Record<string,number>={"1min":1,"5min":5,"15min":15,"30min":30,"1h":60,"4h":240};
 p.values[1]!.datetime=new Date(Date.parse("2026-11-01T12:00:00Z")-minutes[interval]!*60_000).toISOString().replace("T"," ").slice(0,19);
 const result=parseTwelveDataIntradayCandles(p,{...request,interval},NOW);
 assert.equal(result.ok,true);if(result.ok)assert.equal(result.candles[1]?.t,"2026-11-01T12:00:00.000Z");
});}
test("valid leap day is retained and impossible/leap-second clock values are refused",()=>{
 const p=fixture();p.values=p.values.slice(0,1);p.values[0]!.datetime="2024-02-29 12:00:00";
 assert.equal(parseTwelveDataIntradayCandles(p,request,NOW).ok,true);
 for(const time of ["2025-02-29 12:00:00","2026-11-01 24:00:00","2026-11-01 12:00:60","2026-11-01T12:00:00Z"," 2026-11-01 12:00:00"]){
  p.values[0]!.datetime=time;assert.equal(parseTwelveDataIntradayCandles(p,request,NOW).ok,false);
 }
});
test("response errors, oversized rows and nondecimal prices are not partially salvaged",()=>{
 const p=fixture();assert.equal(parseTwelveDataIntradayCandles({...p,status:"error"},request,NOW).ok,false);
 assert.equal(parseTwelveDataIntradayCandles(p,{...request,limit:1},NOW).ok,false);
 for(const value of [""," ","Infinity","0x1","1e2","-1","0"]){p.values[0]!.open=value;assert.equal(parseTwelveDataIntradayCandles(p,request,NOW).ok,false);}
});
test("explicit matching output clock and zero volume are accepted without giving volume authority",()=>{
 const p=fixture();Object.assign(p.meta,{timezone:"UTC"});Object.assign(p.values[0]!,{volume:"0"});
 const result=parseTwelveDataIntradayCandles(p,request,NOW);assert.equal(result.ok,true);
 if(result.ok){assert.equal(result.candles[1]?.v,0);assert.ok(!("volumeEvidence" in result.candles[1]!));}
});
test("cached observations retain original times without making an additional request",async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(fixture());};const provider=getMarketProvider();
 const first=await provider.getCandles("EURUSD","M1",10),second=await provider.getCandles("EURUSD","M1",10);
 assert.equal(calls,1);assert.deepEqual(first.candles,second.candles);assert.equal(second.asOf,"2026-11-01T12:00:00.000Z");
});

test("declared interval cannot contain overlapping candle windows",()=>{const p=fixture();p.meta.interval="5min";assert.equal(parseTwelveDataIntradayCandles(p,{...request,interval:"5min"},NOW).ok,false);});

for(const [timeframe,interval,lastOpen] of [
 ["M1","1min","2026-11-01 12:00:00"],
 ["H4","4h","2026-11-01 08:00:00"],
 ["H4","4h","2026-11-01 12:00:00"],
] as const){test(`${timeframe} bar open ${lastOpen} cannot prove real-time entitlement`,async()=>{
 const p=fixture();p.meta.interval=interval;p.values=p.values.slice(0,1);p.values[0]!.datetime=lastOpen;
 globalThis.fetch=async()=>Response.json(p);
 const result=await getMarketProvider().getCandles("EURUSD",timeframe,10);
 assert.equal(result.candles.length,1);assert.equal(result.freshness,"DELAYED");
 assert.equal(result.asOf,lastOpen.replace(" ","T")+".000Z");
});}
