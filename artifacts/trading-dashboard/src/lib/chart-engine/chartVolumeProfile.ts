import type { ChartEngineCandle } from './types';
import type { ChartStudy } from './chartStudies';
import { observedTradeVolume, TRADE_VOLUME_AUTHORITY } from './chartVolume';
import { originalUtcAuthority } from './chartClockEvidence';
export const VOLUME_PROFILE_METHOD='ohlc-uniform-range-v1' as const;
export const MAX_PROFILE_BARS=5000;
export interface ProfileCandleEvidence {finality:'closed'|'forming'|'unqualified';clockAuthority:string|null}
export interface VolumeProfileRange {kind:'observed_range';fromTime:number;toTime:number;seriesIdentity:string;clockAuthority:string}
export interface VolumeProfileRow {readonly low:number;readonly high:number;readonly estimatedTradeUnits:number}
export type VolumeProfileResult={status:'held';method:typeof VOLUME_PROFILE_METHOD;reason:string}|{
 status:'ready';method:typeof VOLUME_PROFILE_METHOD;range:VolumeProfileRange;rowCount:number;requestedRowCount:number;omittedFormingTail:number;barCount:number;totalTradeUnits:number;rows:readonly VolumeProfileRow[];pocIndex:number;
 valueArea:{low:number;high:number;fromIndex:number;toIndex:number;targetPercent:number;achievedPercent:number;estimatedTradeUnits:number};unit:'provider_trade_units';limitations:readonly string[];
};
export interface VolumeProfileInspection {id:string;label:string;visible:boolean;result:VolumeProfileResult}
export function profileCandleEvidence(bar:{isFinal?:unknown;isComplete?:unknown;isForming?:unknown;timeBasisEvidence?:unknown;qualityFlags?:unknown}):ProfileCandleEvidence {
 const invalid=Array.isArray(bar.qualityFlags)&&bar.qualityFlags.some(flag=>['OHLC_INVALID','TIMESTAMP_INVALID','DUPLICATE_BUCKET','ZERO_VOLUME_GHOST','MOCK_DATA','STALE_FROM_PREV_TF'].includes(String(flag)));
 if(invalid||(Array.isArray(bar.qualityFlags)&&bar.qualityFlags.includes('FORMING_BAR')&&(bar.isFinal===true||bar.isComplete===true)))return {finality:'unqualified',clockAuthority:null};
 return {finality:bar.isFinal===true&&bar.isComplete===true&&bar.isForming===false?'closed':bar.isFinal===false&&bar.isComplete===false&&typeof bar.isForming==='boolean'?'forming':'unqualified',clockAuthority:originalUtcAuthority(bar.timeBasisEvidence)};
}
export function sameProfileEvidence(a:ProfileCandleEvidence|undefined,b:ProfileCandleEvidence|undefined):boolean {return a?.finality===b?.finality&&a?.clockAuthority===b?.clockAuthority;}
const time=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<1e11;
export function validProfileRange(v:unknown):v is VolumeProfileRange {
 const r=v as Partial<VolumeProfileRange>|null;return !!r&&r.kind==='observed_range'&&time(r.fromTime)&&time(r.toTime)&&r.fromTime<=r.toTime&&typeof r.seriesIdentity==='string'&&/^[a-f0-9]{64}$/.test(r.seriesIdentity)&&r.clockAuthority===TRADE_VOLUME_AUTHORITY;
}
export function validProfileRows(v:unknown):v is number{return typeof v==='number'&&Number.isInteger(v)&&v>=8&&v<=128;}
export function validProfileValueArea(v:unknown):v is number{return typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=100;}
const hold=(reason:string):VolumeProfileResult=>Object.freeze({status:'held',method:VOLUME_PROFILE_METHOD,reason});
/** Every loaded selected row participates; time gaps are disclosed, never filled.
 * The producer's traded units do not prove executions at the candle's prices. */
export function calculateVolumeProfile(bars:readonly ChartEngineCandle[],range:VolumeProfileRange|undefined,rowCount:number,valueAreaPercent:number):VolumeProfileResult {
 if(!validProfileRange(range))return hold('Select a frozen original range with qualified traded volume and original UTC evidence.');
 if(!validProfileRows(rowCount)||!validProfileValueArea(valueAreaPercent))return hold('Profile rows must be 8–128 and value area must be an integer 1–100 percent.');
 let from=-1,to=-1,previous=-Infinity;
 for(let i=0;i<bars.length;i++){const t=bars[i]!.time;if(!time(t)||t<=previous)return hold('Original candle timestamps must be unique and ascending.');previous=t;if(t===range.fromTime)from=i;if(t===range.toTime)to=i;}
 if(from<0||to<from)return hold('The frozen profile endpoints are not both loaded; no substitute range was used.');
 if(to-from+1>MAX_PROFILE_BARS)return hold(`Profile accepts at most ${MAX_PROFILE_BARS} loaded bars; this range was not downsampled.`);
 let low=Infinity,high=-Infinity,total=0;
 for(let i=from;i<=to;i++){
  const b=bars[i]!,v=observedTradeVolume(b.volumeEvidence);
  if(!v||v.seriesIdentity!==range.seriesIdentity)return hold('Every selected bar needs qualified positive traded volume from the frozen source series; ticks or missing quantities cannot substitute.');
  if(b.profileEvidence?.finality!=='closed'||b.profileEvidence.clockAuthority!==range.clockAuthority)return hold('Every selected bar needs original closed status and matching original UTC evidence; partial or withdrawn evidence holds the whole profile.');
  if(![b.open,b.high,b.low,b.close].every(n=>Number.isFinite(n)&&n>0)||b.high<Math.max(b.open,b.close,b.low)||b.low>Math.min(b.open,b.close,b.high))return hold('Original candle prices are invalid; no partial profile was salvaged.');
  total+=v.quantity;if(!Number.isSafeInteger(total))return hold('Total traded quantity exceeds exact safe integer arithmetic.');low=Math.min(low,b.low);high=Math.max(high,b.high);
 }
 const span=high-low,n=span===0?1:rowCount,step=span/n;
 if(!Number.isFinite(span)||span<0||!Number.isFinite(step))return hold('Price-bin arithmetic is unsupported for this range.');
 const edges=Array.from({length:n+1},(_,i)=>i===n?high:low+i*step);
 if(span>0&&edges.some((edge,i)=>i>0&&edge<=edges[i-1]!))return hold('Requested price bins collapse at this numeric precision; reduce rows or select a wider range.');
 const quantities=new Float64Array(n),difference=new Float64Array(n+1);
 for(let i=from;i<=to;i++){
  const b=bars[i]!,v=observedTradeVolume(b.volumeEvidence)!.quantity;
  const index=(price:number)=>{let lo=0,hi=n;while(lo<hi){const mid=(lo+hi+1)>>>1;if(edges[mid]!<=price)lo=mid;else hi=mid-1;}return Math.min(n-1,lo);};
  if(span===0){quantities[0]!+=v;continue;}
  if(b.high===b.low){quantities[index(b.low)]!+=v;continue;}
  const first=index(b.low),last=index(b.high),width=b.high-b.low;
  if(first===last){quantities[first]!+=v;continue;}
  quantities[first]!+=v*(edges[first+1]!-b.low)/width;
  quantities[last]!+=v*(b.high-edges[last]!)/width;
  // Full interior rows have a constant density. Prefix differences keep work
  // linear in observed bars + bins; no pan-dependent recalculation is needed.
  if(last>first+1){const density=v/width;difference[first+1]!+=density;difference[last]!-=density;}
 }
 let density=0,allocated=0;
 // Use actual edge widths (IEEE rounding can make adjacent widths differ).
 const resultRows:VolumeProfileRow[]=[];
 for(let i=0;i<n;i++){density+=difference[i]!;let value=quantities[i]!+density*(edges[i+1]!-edges[i]!);if(value<0&&value>-1e-12*total)value=0;if(!Number.isFinite(value)||value<0)return hold('Volume allocation arithmetic is non-finite or negative.');allocated+=value;resultRows.push({low:edges[i]!,high:edges[i+1]!,estimatedTradeUnits:value});}
 if(!Number.isFinite(allocated)||Math.abs(allocated-total)>1e-9*Math.max(1,total))return hold('Estimated allocations do not conserve the original total within numeric tolerance.');
 let poc=0;for(let i=1;i<n;i++)if(resultRows[i]!.estimatedTradeUnits>resultRows[poc]!.estimatedTradeUnits)poc=i;
 let lo=poc,hi=poc,included=resultRows[poc]!.estimatedTradeUnits;const target=total*valueAreaPercent/100;
 while(included<target&&(lo>0||hi<n-1)){
  const below=lo>0?lo-1:null,above=hi<n-1?hi+1:null;
  let next:number;
  if(below==null)next=above!;else if(above==null)next=below;else {const a=resultRows[above]!.estimatedTradeUnits,b=resultRows[below]!.estimatedTradeUnits;next=a>b?above:b>a?below:above-poc<=poc-below?above:below;}
  const extra=resultRows[next]!.estimatedTradeUnits;
  if(valueAreaPercent<100&&included+extra>target)break;
  included+=extra;if(next<lo)lo=next;else hi=next;
 }
 const result:VolumeProfileResult={status:'ready',method:VOLUME_PROFILE_METHOD,range:{...range},rowCount:n,requestedRowCount:rowCount,omittedFormingTail:to===bars.length-2&&bars[to+1]?.profileEvidence?.finality==='forming'?1:0,barCount:to-from+1,totalTradeUnits:total,rows:resultRows,pocIndex:poc,valueArea:{low:resultRows[lo]!.low,high:resultRows[hi]!.high,fromIndex:lo,toIndex:hi,targetPercent:valueAreaPercent,achievedPercent:included/total*100,estimatedTradeUnits:included},unit:'provider_trade_units',limitations:[
 'Estimated allocation: uniform traded-volume density across each original candle high–low range, not observed executions at each price.',
 'Loaded closed observations only; time gaps are not zero-volume proof. No complete-session or lower-timeframe coverage claim.',
 'Provider-reported trade units, not proven shares, consolidated market volume, bid/ask liquidity or aggressor order flow.',
 'POC ties choose the lowest-price row. Value area starts with POC, adds the larger adjacent row, and stops before exceeding the target; ties choose closer to POC then above. POC alone may exceed the target.',
 ]};
 Object.freeze(result.range);result.rows.forEach(Object.freeze);Object.freeze(result.rows);Object.freeze(result.valueArea);Object.freeze(result.limitations);return Object.freeze(result);
}
export function prepareVolumeProfileStudy(config:ChartStudy,bars:readonly ChartEngineCandle[],selection?:{fromTime:number;toTime:number}):{study:ChartStudy;reason?:never}|{reason:string;study?:never} {
 if(config.kind!=='volume_profile'||config.profileRange&&!selection)return {study:config};
 let last=bars.length-1;if(!selection&&last>=0&&bars[last]!.profileEvidence?.finality==='forming')last--;
 const firstTime=selection?.fromTime??bars[0]?.time,lastTime=selection?.toTime??bars[last]?.time;
 const first=bars.find(b=>b.time===firstTime),volume=observedTradeVolume(first?.volumeEvidence);
 if(!first||!time(lastTime)||!volume||first.profileEvidence?.finality!=='closed'||first.profileEvidence.clockAuthority!==TRADE_VOLUME_AUTHORITY)return {reason:'Profile not changed: choose an original closed range with qualified traded volume and original UTC evidence. No missing first bar was skipped.'};
 const range:VolumeProfileRange={kind:'observed_range',fromTime:first.time,toTime:lastTime,seriesIdentity:volume.seriesIdentity,clockAuthority:first.profileEvidence.clockAuthority};
 const result=calculateVolumeProfile(bars,range,config.profileRows??32,config.profileValueAreaPercent??70);
 return result.status==='held'?{reason:result.reason}:{study:{...config,profileRows:config.profileRows??32,profileValueAreaPercent:config.profileValueAreaPercent??70,profileRange:range}};
}
