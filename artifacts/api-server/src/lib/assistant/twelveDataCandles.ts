import { createHash } from "node:crypto";
import { findMarketByStandardSymbol } from "@workspace/markets";
import type { CandleVolumeEvidence } from "../data/candleVolumeEvidence.js";
import type { CandleTimeBasisEvidence } from "../data/candleTimeBasisEvidence.js";
import type { OriginalCandleContext } from "./polygonFxCandles.js";
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
export const TWELVE_DATA_STOCK_AUTHORITY = "twelve-data:time-series:common-stock:regular-unadjusted:v1";
export interface TwelveDataRequest {symbol:string;interval:string;limit:number;timezone:"UTC";order:"desc";type?:"Common Stock";adjust?:"none";prepost?:false}
const CANONICAL_INTERVAL:Readonly<Record<string,string>>={"1min":"M1","5min":"M5","15min":"M15","30min":"M30","1h":"H1","4h":"H4"};
interface Witness {symbol:string;timeframe:string;bar:string;seriesIdentity:string;kind:"time"|"volume"}
const witnesses=new WeakMap<object,Witness>();
const fingerprint=(c:{time:string;open:number;high:number;low:number;close:number;volume?:number})=>JSON.stringify([c.time,c.open,c.high,c.low,c.close,c.volume]);
/** Runtime provenance survives reference-preserving memory only; raw labels,
 * JSON/cache rehydration, different bars and caller metadata cannot issue it. */
export function isOriginalTwelveDataStockEvidence(evidence:unknown,source:string|null|undefined,context:(OriginalCandleContext & {candle:OriginalCandleContext["candle"] & {volume?:number;originalVolumeSeriesIdentity?:string}})|undefined,kind:Witness["kind"]):boolean {
 if(source!=="assistant_real:twelve_data" || !context || !evidence || typeof evidence!=="object")return false;
 const witness=witnesses.get(evidence);
 return !!witness && witness.kind===kind && witness.symbol===context.symbol && witness.timeframe===context.timeframe && witness.bar===fingerprint(context.candle) && witness.seriesIdentity===context.candle.originalVolumeSeriesIdentity;
}
export type TwelveDataCandleRead = {ok:true;candles:Candle[];freshness:"DELAYED"} | {ok:false;reason:string};
/** Only call for this adapter's explicit timezone=UTC, order=desc request.
 * No timezone conversion, partial salvage or synthetic rows. Only the explicit
 * stock subset issues original UTC/trade-unit evidence; price basis stays unknown.
 * Dates name ORIGINAL BAR OPENS (not closes); daily local dates are unsupported.
 */
export function parseTwelveDataIntradayCandles(payload:unknown,request:TwelveDataRequest,now=Date.now()):TwelveDataCandleRead {
  const unavailable=(reason:string):TwelveDataCandleRead=>({ok:false,reason});
  const intervalMs=twelveDataIntradayMs(request.interval);
  if(!intervalMs || request.timezone!=="UTC" || request.order!=="desc" || !Number.isSafeInteger(request.limit) || request.limit<1 || request.limit>200 || !Number.isFinite(now))return unavailable("UNSUPPORTED_UTC_REQUEST");
  const data=record(payload),meta=record(data?.meta);
  if(data?.status!=="ok" || !meta || meta.symbol!==request.symbol || meta.interval!==request.interval || !exchangeClock(meta.exchange_timezone))return unavailable("UNVERIFIED_CANDLE_METADATA");
  // The contract does not require a separate output-zone echo. Reject one if
  // supplied and conflicting; never confuse exchange_timezone with that echo.
  if((Object.hasOwn(meta,"timezone") && meta.timezone!=="UTC") || (Object.hasOwn(data,"timezone") && data.timezone!=="UTC"))return unavailable("CONFLICTING_OUTPUT_CLOCK");
  const stockRequest=request.type!==undefined || request.adjust!==undefined || request.prepost!==undefined;
  let seriesIdentity:string|null=null;
  if(stockRequest){
    if(request.type!=="Common Stock" || request.adjust!=="none" || request.prepost!==false || findMarketByStandardSymbol(request.symbol)?.assetClass!=="stock")return unavailable("UNSUPPORTED_STOCK_VOLUME_REQUEST");
    if(meta.type!=="Common Stock" || typeof meta.mic_code!=="string" || !/^[A-Z0-9]{4}$/.test(meta.mic_code) || typeof meta.exchange!=="string" || !/^[A-Za-z0-9 ._&()/-]{1,80}$/.test(meta.exchange) || meta.exchange.trim()!==meta.exchange || typeof meta.currency!=="string" || !/^[A-Z]{3}$/.test(meta.currency))return unavailable("UNVERIFIED_STOCK_LISTING");
    for(const echo of [meta,data])if((Object.hasOwn(echo,"adjust") && echo.adjust!=="none") || (Object.hasOwn(echo,"prepost") && echo.prepost!==false) || (Object.hasOwn(echo,"type") && echo.type!=="Common Stock"))return unavailable("CONTRADICTORY_STOCK_SCOPE");
    // This is the provider-returned listing, not an independently pinned venue
    // or consolidated tape. Unadjusted data may cross corporate-action breaks.
    seriesIdentity=createHash("sha256").update(JSON.stringify([TWELVE_DATA_STOCK_AUTHORITY,request.symbol,request.interval,meta.mic_code,meta.exchange,meta.currency,meta.type,meta.exchange_timezone,"UTC","none",false])).digest("hex");
  }
  if(!Array.isArray(data.values) || data.values.length===0 || data.values.length>request.limit)return unavailable("INVALID_CANDLE_ROWS");
  const candles:Candle[]=[];let previous=Infinity;
  for(const value of data.values){
    const row=record(value);if(!row)return unavailable("INVALID_CANDLE_ROW");
    const t=originalUtcOpen(row.datetime,now);
    if(!t || Date.parse(t)>=previous || previous-Date.parse(t)<intervalMs)return unavailable("INVALID_CANDLE_TIME");
    const o=decimal(row.open),h=decimal(row.high),l=decimal(row.low),c=decimal(row.close);
    const v=Object.hasOwn(row,"volume")?decimal(row.volume,true):0;
    if(o===null || h===null || l===null || c===null || v===null || h<Math.max(o,l,c) || l>Math.min(o,h,c))return unavailable("INVALID_CANDLE_PRICES");
    previous=Date.parse(t);
    const candle:Candle={t,o,h,l,c,v};
    if(seriesIdentity){
      candle.originalVolumeSeriesIdentity=seriesIdentity;
      const witness={symbol:request.symbol,timeframe:CANONICAL_INTERVAL[request.interval]!,seriesIdentity,bar:fingerprint({time:t,open:o,high:h,low:l,close:c,volume:v})};
      const timeBasisEvidence:CandleTimeBasisEvidence=Object.freeze({kind:"original_utc",basis:"UTC",authority:TWELVE_DATA_STOCK_AUTHORITY,reason:null});
      witnesses.set(timeBasisEvidence,{...witness,kind:"time"});candle.timeBasisEvidence=timeBasisEvidence;
      if(typeof row.volume==="string" && /^\d+(?:\.0+)?$/.test(row.volume) && Number.isSafeInteger(v) && v>0 && Date.parse(t)+intervalMs<=now){
        const volumeEvidence:CandleVolumeEvidence=Object.freeze({kind:"real_volume",quantity:v,unit:"provider_trade_units",authority:TWELVE_DATA_STOCK_AUTHORITY,seriesIdentity,reason:null});
        witnesses.set(volumeEvidence,{...witness,kind:"volume"});candle.volumeEvidence=volumeEvidence;
      }else candle.volumeEvidence={kind:"unavailable",quantity:null,unit:null,reason:Date.parse(t)+intervalMs>now?"The stock bar is still forming; final traded volume is unavailable.":"Original positive whole provider trade units were not supplied; missing, zero and fractional quantities are not qualified."};
    }
    candles.push(candle);
  }
  candles.reverse();
  // A bar opening recently (especially H4) proves neither current observation
  // nor real-time plan entitlement. Preserve history without upgrading liveness.
  return {ok:true,candles,freshness:"DELAYED"};
}
