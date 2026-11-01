import type { CandlePriceBasisEvidence } from "../data/candlePriceBasisEvidence.js";
import type { CandleTimeBasisEvidence } from "../data/candleTimeBasisEvidence.js";

/** Audited REST forex custom-bars endpoint only; grouped/day summary timestamps
 * differ. Quote counts are not traded volume. No live entitlement is inferred. */
export const POLYGON_FX_AUTHORITY = "massive:forex-custom-bars:utc-bid:v1";
export const POLYGON_FX_INTERVALS: Readonly<Record<string,{multiplier:number;timespan:string;barSeconds:number}>> = {
  M1:{multiplier:1,timespan:"minute",barSeconds:60},M5:{multiplier:5,timespan:"minute",barSeconds:300},
  M15:{multiplier:15,timespan:"minute",barSeconds:900},M30:{multiplier:30,timespan:"minute",barSeconds:1800},
  H1:{multiplier:1,timespan:"hour",barSeconds:3600},H4:{multiplier:4,timespan:"hour",barSeconds:14400},
  D1:{multiplier:1,timespan:"day",barSeconds:86400},
};
const PAIRS=new Set(["EURUSD","GBPUSD","USDJPY","XAUUSD","AUDUSD","USDCAD","USDCHF","NZDUSD"]);
interface Bar {time:string;open:number;high:number;low:number;close:number}
export interface OriginalCandleContext {candle:Bar;symbol:string;timeframe:string}
interface Witness {bar:string;symbol:string;timeframe:string;kind:"price"|"time"}
// Runtime-issued, bar-bound identities survive only in-process reference-preserving
// caches. JSON, DB rows, caller labels and spread copies of evidence cannot mint them.
const witnesses=new WeakMap<object,Witness>();
const fingerprint=(c:Bar)=>JSON.stringify([c.time,c.open,c.high,c.low,c.close]);
export function isOriginalPolygonEvidence(evidence:unknown,source:string|null,context:OriginalCandleContext|undefined,kind:Witness["kind"]):boolean {
  if(source!=="assistant_real:polygon"||!context||!evidence||typeof evidence!=="object")return false;
  const witness=witnesses.get(evidence);
  return !!witness&&witness.kind===kind&&witness.symbol===context.symbol&&witness.timeframe===context.timeframe&&witness.bar===fingerprint(context.candle);
}
export interface PolygonFxCandle {t:string;o:number;h:number;l:number;c:number;v:number;timeBasisEvidence:CandleTimeBasisEvidence;priceBasisEvidence:CandlePriceBasisEvidence}
export interface PolygonFxRequest {ticker:string;timeframe:string;fromMs:number;toMs:number;nowMs:number;maxBars:number}
export type PolygonFxParse = {ok:true;candles:PolygonFxCandle[];notes:string}|{ok:false;candles:[];reason:string};
const record=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const fail=(reason:string):PolygonFxParse=>({ok:false,candles:[],reason});
/** Validate the actual endpoint response before issuing evidence. Descending is
 * explicitly requested. Never sort, deduplicate or silently drop malformed rows. */
export function parsePolygonFxCustomBars(value:unknown,request:PolygonFxRequest):PolygonFxParse {
  if(!request || typeof request.ticker!=="string" || !Object.hasOwn(POLYGON_FX_INTERVALS,request.timeframe))return fail("INVALID_REQUEST_CONTEXT");
  const tf=POLYGON_FX_INTERVALS[request.timeframe],symbol=request.ticker.slice(2);
  if(!tf||request.ticker!==`C:${symbol}`||!PAIRS.has(symbol)||![request.fromMs,request.toMs,request.nowMs,request.maxBars].every(Number.isSafeInteger)
    ||request.fromMs<0||request.fromMs%86_400_000!==0||request.toMs%86_400_000!==86_399_999||request.toMs>8_640_000_000_000_000||request.nowMs>8_640_000_000_000_000||request.toMs<request.fromMs||request.nowMs<=0||request.maxBars<1||request.maxBars>200)return fail("INVALID_REQUEST_CONTEXT");
  const body=record(value);
  if(!body||body.status!=="OK"||body.ticker!==request.ticker)return fail("RESPONSE_IDENTITY_OR_STATUS_MISMATCH");
  if(!Array.isArray(body.results)||body.results.length===0||body.results.length>50_000)return fail("NO_BOUNDED_RESULTS");
  if(body.resultsCount!==undefined&&(!Number.isSafeInteger(body.resultsCount)||body.resultsCount!==body.results.length))return fail("RESULT_COUNT_MISMATCH");
  const intervalMs=tf.barSeconds*1000;
  const closed:Array<{t:number;o:number;h:number;l:number;c:number;v:number}>=[];
  let previous=Infinity,forming=0;
  for(const value of body.results){
    const row=record(value);
    if(!row||typeof row.t!=="number"||!Number.isSafeInteger(row.t)||row.t<request.fromMs||row.t>request.toMs||row.t>request.nowMs
      ||row.t>=previous)return fail("INVALID_DUPLICATE_OR_UNORDERED_TIMESTAMP");
    // This adapter requests midnight-aligned dates only. Other aggregation
    // grids may be valid provider data but are outside this audited subset.
    if(row.t%intervalMs!==0)return fail("UNSUPPORTED_AGGREGATE_GRID");
    previous=row.t;
    if(![row.o,row.h,row.l,row.c].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0))return fail("INVALID_OHLC");
    const o=row.o as number,h=row.h as number,l=row.l as number,c=row.c as number;
    if(h<Math.max(o,c)||l>Math.min(o,c)||h<l)return fail("INVALID_OHLC_GEOMETRY");
    // A quoted OHLC bar must have at least one quote when a count is supplied.
    // Keep the legacy numeric quote-count field for compatibility; missing is
    // not observed zero and NEVER produces volumeEvidence or traded volume.
    if(row.v!==undefined&&(!Number.isSafeInteger(row.v)||(row.v as number)<=0))return fail("INVALID_QUOTE_COUNT");
    if(row.n!==undefined&&(!Number.isSafeInteger(row.n)||(row.n as number)<=0))return fail("INVALID_QUOTE_COUNT");
    if(row.n!==undefined&&row.v!==undefined&&row.n!==row.v)return fail("CONTRADICTORY_QUOTE_COUNTS");
    if(row.t+intervalMs>request.nowMs){forming++;continue;}
    closed.push({t:row.t,o,h,l,c,v:typeof row.v==="number"?row.v:0});
  }
  if(!closed.length)return fail("NO_CLOSED_RESULTS");
  const candles=closed.slice(0,request.maxBars).reverse().map(row=>{
    const t=new Date(row.t).toISOString();
    const timeBasisEvidence:CandleTimeBasisEvidence=Object.freeze({kind:"original_utc",basis:"UTC",authority:POLYGON_FX_AUTHORITY,reason:null});
    const priceBasisEvidence:CandlePriceBasisEvidence=Object.freeze({kind:"producer_declared",basis:"BID",reason:null});
    const witness={bar:fingerprint({time:t,open:row.o,high:row.h,low:row.l,close:row.c}),symbol,timeframe:request.timeframe};
    witnesses.set(timeBasisEvidence,{...witness,kind:"time"});witnesses.set(priceBasisEvidence,{...witness,kind:"price"});
    return {t,o:row.o,h:row.h,l:row.l,c:row.c,v:row.v,timeBasisEvidence,priceBasisEvidence};
  });
  return {ok:true,candles,notes:`Loaded closed FX bid bars only; UTC follows the audited custom-bars endpoint. Live entitlement and requested-history completeness are unverified. Limit counts base aggregates, not guaranteed output bars; pagination is not followed. ${forming} forming bars omitted. Volume fields are quote counts, not traded size.`};
}
