import type { Candle } from "./marketProvider.js";

// Twelve Data honors timezone=UTC only below 1day. Its exchange_timezone is
// instrument metadata, NOT an echo of the requested output timezone.
// https://twelvedata.com/docs#time-series
const INTRADAY_MS: Readonly<Record<string, number>> = {
  "1min":60_000,"5min":300_000,"15min":900_000,"30min":1_800_000,"1h":3_600_000,"4h":14_400_000,
};
export function twelveDataIntradayMs(interval: string): number | null {
  return Object.hasOwn(INTRADAY_MS,interval) ? INTRADAY_MS[interval]! : null;
}
function record(value: unknown): Record<string,unknown> | null {
  return value!==null && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : null;
}
function exchangeClock(value: unknown): boolean {
  if(typeof value!=="string" || value.length===0 || value.trim()!==value || value.length>80)return false;
  try{new Intl.DateTimeFormat("en",{timeZone:value}).format(0);return true;}catch{return false;}
}
function decimal(value:unknown,allowZero=false):number|null {
  if(typeof value!=="string" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))return null;
  const parsed=Number(value);return Number.isFinite(parsed) && (allowZero?parsed>=0:parsed>0) ? parsed : null;
}
function originalUtcOpen(value:unknown,now:number):string|null {
  if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value))return null;
  const iso=value.replace(" ","T")+".000Z",ms=Date.parse(iso);
  return Number.isSafeInteger(ms) && ms>0 && ms<=now && new Date(ms).toISOString()===iso ? iso : null;
}
export type TwelveDataCandleRead = {ok:true;candles:Candle[];freshness:"DELAYED"} | {ok:false;reason:string};
/** Only call for this adapter's explicit timezone=UTC, order=desc request.
 * No timezone conversion, partial salvage, synthetic rows or research authority.
 * Dates name ORIGINAL BAR OPENS (not closes); daily local dates are unsupported.
 */
export function parseTwelveDataIntradayCandles(payload:unknown,request:{symbol:string;interval:string;limit:number;timezone:"UTC";order:"desc"},now=Date.now()):TwelveDataCandleRead {
  const unavailable=(reason:string):TwelveDataCandleRead=>({ok:false,reason});
  const intervalMs=twelveDataIntradayMs(request.interval);
  if(!intervalMs || request.timezone!=="UTC" || request.order!=="desc" || !Number.isSafeInteger(request.limit) || request.limit<1 || request.limit>200 || !Number.isFinite(now))return unavailable("UNSUPPORTED_UTC_REQUEST");
  const data=record(payload),meta=record(data?.meta);
  if(data?.status!=="ok" || !meta || meta.symbol!==request.symbol || meta.interval!==request.interval || !exchangeClock(meta.exchange_timezone))return unavailable("UNVERIFIED_CANDLE_METADATA");
  // The contract does not require a separate output-zone echo. Reject one if
  // supplied and conflicting; never confuse exchange_timezone with that echo.
  if((Object.hasOwn(meta,"timezone") && meta.timezone!=="UTC") || (Object.hasOwn(data,"timezone") && data.timezone!=="UTC"))return unavailable("CONFLICTING_OUTPUT_CLOCK");
  if(!Array.isArray(data.values) || data.values.length===0 || data.values.length>request.limit)return unavailable("INVALID_CANDLE_ROWS");
  const candles:Candle[]=[];let previous=Infinity;
  for(const value of data.values){
    const row=record(value);if(!row)return unavailable("INVALID_CANDLE_ROW");
    const t=originalUtcOpen(row.datetime,now);
    if(!t || Date.parse(t)>=previous || previous-Date.parse(t)<intervalMs)return unavailable("INVALID_CANDLE_TIME");
    const o=decimal(row.open),h=decimal(row.high),l=decimal(row.low),c=decimal(row.close);
    const v=Object.hasOwn(row,"volume")?decimal(row.volume,true):0;
    if(o===null || h===null || l===null || c===null || v===null || h<Math.max(o,l,c) || l>Math.min(o,h,c))return unavailable("INVALID_CANDLE_PRICES");
    previous=Date.parse(t);candles.push({t,o,h,l,c,v});
  }
  candles.reverse();
  // A bar opening recently (especially H4) proves neither current observation
  // nor real-time plan entitlement. Preserve history without upgrading liveness.
  return {ok:true,candles,freshness:"DELAYED"};
}
