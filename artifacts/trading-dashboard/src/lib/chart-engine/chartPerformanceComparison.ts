import type { ChartCandlesResponse } from "@workspace/api-client-react";
import { matchesChartCandleOwner } from "../chartCandleOwner";
import { captureSmartChartBars } from "./smartChartCapture";
import { chartUtcClockQualified } from "./chartClockEvidence";
import { chartIntervalSeconds } from "./chartIntervals";

export interface PerformanceRow { time:number; primary:number|null; comparison:number|null }
interface SourceNote { symbol:string; source:string; sourceIdentity:string; stale:boolean; lastClosedAt:number }
type ComparisonResult = {status:"unavailable";reason:string} | {
  status:"ready"; rows:PerformanceRow[]; interval:number;
  baseline:{time:number;primary:number;comparison:number};
  lastCommon:PerformanceRow & {primary:number;comparison:number};
  primary:SourceNote; comparison:SourceNote;
};

/** Read-only comparison of original CLOSED observations. One common origin,
 * exact UTC bucket joins, no nearest-neighbour filling or currency conversion.
 * A percentage line is presentation data, never canonical OHLC or trade input. */
export function compareChartPerformance(input:{primary:ChartCandlesResponse|undefined;comparison:ChartCandlesResponse|undefined;
  primarySymbol:string;comparisonSymbol:string;timeframe:string;range:{from:number;to:number}|null;now:number}):ComparisonResult {
  const unavailable=(reason:string):ComparisonResult=>({status:"unavailable",reason});
  const interval=chartIntervalSeconds(input.timeframe),range=input.range;
  if(!interval||!range||!Number.isFinite(range.from)||!Number.isFinite(range.to)||range.to<=range.from||!Number.isFinite(input.now))
    return unavailable("Waiting for a supported interval and visible chart range.");
  const series=[];
  for(const [data,symbol] of [[input.primary,input.primarySymbol],[input.comparison,input.comparisonSymbol]] as const){
    if(!data||!matchesChartCandleOwner(data,symbol,input.timeframe))return unavailable(`${symbol}: waiting for matching source candles.`);
    if(!chartUtcClockQualified(data.candles))return unavailable(`${symbol}: original UTC timestamps are unverified; cross-market alignment is withheld.`);
    const captured=captureSmartChartBars(data,{symbol,timeframe:input.timeframe},[],null,input.now);
    if(captured.status!=="ready")return unavailable(`${symbol}: ${captured.reason}`);
    const bars=captured.bars;
    if(bars.some((bar,index)=>!Number.isFinite(bar.time)||bar.time<=0||!Number.isFinite(bar.closeTime)
      ||index>0&&bar.time<bars[index-1]!.closeTime-0.001
      ||bar.closeTime*1000>input.now||Math.abs(bar.closeTime-bar.time-interval)>0.001
      ||![bar.open,bar.high,bar.low,bar.close].every(value=>Number.isFinite(value)&&value>0)
      ||bar.low>Math.min(bar.open,bar.close)||bar.high<Math.max(bar.open,bar.close)||bar.high<bar.low))
      return unavailable(`${symbol}: invalid prices or closed-candle times; comparison withheld.`);
    series.push({bars,note:{symbol,source:captured.context.source!,sourceIdentity:captured.context.sourceIdentity!,
      stale:data.feedStatus.stale===true,lastClosedAt:bars.at(-1)!.closeTime}});
  }
  const [a,b]=series as [typeof series[number],typeof series[number]];
  const first=new Map(a.bars.filter(c=>c.time>=range.from&&c.time<=range.to).map(c=>[c.time,c.close]));
  const second=new Map(b.bars.filter(c=>c.time>=range.from&&c.time<=range.to).map(c=>[c.time,c.close]));
  const common=[...first.keys()].filter(t=>second.has(t));
  if(common.length<2)return unavailable("At least two matching closed bars are needed in the visible range. Pan or zoom within both loaded histories.");
  const origin=common[0]!,baseA=first.get(origin)!,baseB=second.get(origin)!;
  const percent=(close:number|undefined,base:number)=>close===undefined?null:(close-base)/base*100;
  const times=[...new Set([...first.keys(),...second.keys()])].filter(t=>t>=origin).sort((x,y)=>x-y);
  const rows=times.map(time=>({time,primary:percent(first.get(time),baseA),comparison:percent(second.get(time),baseB)}));
  if(rows.some(row=>[row.primary,row.comparison].some(v=>v!==null&&!Number.isFinite(v))))return unavailable("The percentage change exceeds the supported numeric range.");
  const lastCommon=rows.find(row=>row.time===common.at(-1))! as PerformanceRow & {primary:number;comparison:number};
  return {status:"ready",rows,interval,baseline:{time:origin,primary:baseA,comparison:baseB},lastCommon,primary:a.note,comparison:b.note};
}

/** Break the stroke at every missing observation or time gap. Dots are drawn
 * separately by the view so isolated observed bars do not disappear. */
export function comparisonPaths(rows:readonly PerformanceRow[],key:"primary"|"comparison",interval:number,
  x:(time:number)=>number,y:(value:number)=>number):string {
  let path="",previous:number|null=null;
  for(const row of rows){
    const value=row[key];if(value===null){previous=null;continue;}
    const connected=previous!==null&&Math.abs(row.time-previous-interval)<0.001;
    path+=`${connected?"L":"M"}${x(row.time).toFixed(2)},${y(value).toFixed(2)} `;previous=row.time;
  }
  return path.trim();
}
