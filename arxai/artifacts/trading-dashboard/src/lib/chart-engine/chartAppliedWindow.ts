import { selectSmartChartWindow, type SmartChartAnalysisInput, type SmartChartSelectedWindow } from "./smartChartAnalysis";
import type { ChartEngineCandle } from "./types";
/** Shared qualification for automatic drawings, over the actual installed window. */
export function selectAppliedSmartChartWindow(input:SmartChartAnalysisInput,actual:readonly ChartEngineCandle[],tool:string):{status:"ready";selected:SmartChartSelectedWindow;comparisonKey:string}|{status:"unavailable";reason:string} {
  const unavailable=(reason:string)=>({status:"unavailable" as const,reason});
  if(!actual.length)return unavailable(`Load visible source candles before showing ${tool}.`);
  const byTime=new Map(input.bars.map(bar=>[bar.time,bar]));
  for(const [index,bar] of actual.entries()) {
    if(!Number.isFinite(bar.time)||index>0&&bar.time<=actual[index-1]!.time)return unavailable("The applied chart window is not chronological.");
    const original=byTime.get(bar.time);
    if(!original) {
      // The renderer may have one streaming tip beyond the closed history.
      if(input.replayCutoff==null&&index===actual.length-1&&bar.time>=(input.bars.at(-1)?.closeTime??Infinity))continue;
      return unavailable("Visible candles lack matching original source evidence.");
    }
    if(input.replayCutoff!=null&&original.closeTime>input.replayCutoff)return unavailable("The applied chart extends beyond the revealed replay boundary.");
    if((["open","high","low","close"] as const).some(key=>original[key]!==bar[key]))return unavailable(`The displayed source prices are updating; ${tool} is withheld.`);
  }
  const selected=selectSmartChartWindow({...input,visibleRange:{from:actual[0]!.time,to:actual.at(-1)!.time}});
  if(selected.status!=="ready")return unavailable(selected.reason!);
  const bars=selected.bars;
  if(bars.some((bar,i)=>i>0&&bar.time<bars[i-1]!.closeTime))return unavailable(`Overlapping candle intervals cannot confirm ${tool}.`);
  const appliedTimes=new Set(actual.map(bar=>bar.time));
  if(bars.some(bar=>!appliedTimes.has(bar.time)))return unavailable("The displayed chart omits source observations in this window; automatic drawings are withheld.");
  return {status:"ready",selected,comparisonKey:JSON.stringify([selected.contextKey,actual[0]!.time,actual.at(-1)!.time,bars])};
}
