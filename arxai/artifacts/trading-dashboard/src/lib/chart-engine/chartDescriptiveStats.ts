import type { SmartChartAnalysisBar } from "./smartChartAnalysis";

/** Describes observed closes only. No execution P/L, forecast, causal inference
 * or statistical-significance claim follows from these sample summaries. */
export function chartDescriptiveStats(bars:readonly SmartChartAnalysisBar[]) {
  if(!bars.length||bars.some(b=>![b.open,b.high,b.low,b.close].every(v=>Number.isFinite(v)&&v>0)))return null;
  let mean=0,m2=0,low=Infinity,high=-Infinity,peak=bars[0]!.close,maxDrawdown=0;
  const closes:number[]=[];
  bars.forEach((bar,i)=>{
    const delta=bar.close-mean;mean+=delta/(i+1);m2+=delta*(bar.close-mean);
    low=Math.min(low,bar.low);high=Math.max(high,bar.high);closes.push(bar.close);
    peak=Math.max(peak,bar.close);maxDrawdown=Math.max(maxDrawdown,(peak-bar.close)/peak*100);
  });
  closes.sort((a,b)=>a-b);
  const mid=Math.floor(closes.length/2),first=bars[0]!.close,last=bars.at(-1)!.close;
  const median=closes.length%2?closes[mid]!:closes[mid-1]!/2+closes[mid]!/2;
  const change=last-first,changePercent=change/first*100,stdDev=Math.sqrt(Math.max(0,m2/bars.length));
  if(![mean,median,change,changePercent,stdDev,maxDrawdown,high-low].every(Number.isFinite))return null;
  return {count:bars.length,first,last,change,changePercent,mean,median,stdDev,low,high,range:high-low,maxDrawdownPercent:maxDrawdown};
}
export function chartNumber(value:number):string {
  if(!Number.isFinite(value))return "Unavailable";
  return Number(value.toPrecision(7)).toString();
}

/** Concise narrative only; numerical evidence retains chartNumber precision.
 * A nonzero move must never become a claim that price stayed level. */
export function chartChangeSummary(change:number,changePercent:number):string {
  if(!Number.isFinite(change)||!Number.isFinite(changePercent))return "change is unavailable";
  if(change===0)return "stayed level";
  const magnitude=Math.abs(changePercent);
  return `${change>0?"rose":"fell"} ${magnitude<0.01?"less than 0.01%":`${Number(magnitude.toFixed(2))}%`}`;
}

/** Elapsed gaps are observations, not proof of missing trades: market closures
 * and provider/session calendars are not established by these bars alone. */
export function chartObservationGaps(bars:readonly SmartChartAnalysisBar[],interval:number) {
  if(!Number.isFinite(interval)||interval<=0)return null;
  let gaps=0,largestSeconds=0;
  for(let i=1;i<bars.length;i++){
    const elapsed=bars[i]!.time-bars[i-1]!.time;
    if(!Number.isFinite(elapsed)||elapsed<=0)return null;
    if(elapsed>interval+0.001){gaps++;largestSeconds=Math.max(largestSeconds,elapsed);}
  }
  return {gaps,largestSeconds};
}
