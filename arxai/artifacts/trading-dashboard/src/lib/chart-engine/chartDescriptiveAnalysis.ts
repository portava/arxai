import { chartDescriptiveStats, chartChangeSummary } from "./chartDescriptiveStats";
import { StudyCalculator } from "./chartStudies";
import { selectSmartChartWindow, smartChartIntervalSeconds, type SmartChartAnalysisInput, type SmartChartSelectedWindow } from "./smartChartAnalysis";

export type ObservedMetric<T> = {status:"available";value:T;reason:null}|{status:"unavailable";value:null;reason:string};
const yes=<T>(value:T):ObservedMetric<T>=>({status:"available",value,reason:null});
const no=<T>(reason:string):ObservedMetric<T>=>({status:"unavailable",value:null,reason});
const number=(value:number|null,reason:string):ObservedMetric<number>=>value!=null&&Number.isFinite(value)?yes(value):no(reason);
export interface WindowTrend {slopePerInterval:number;fittedChangePercent:number;rSquared:number|null;elapsedIntervals:number}
export interface WindowDistribution {q1:number;median:number;q3:number;iqr:number;method:"type7-linear"}
export interface PriorReturnFlag {latestReturnPercent:number;priorReturns:number;q1:number;q3:number;lowerFence:number;upperFence:number;position:"below"|"inside"|"above";method:"prior-returns-type7-1.5iqr"}
export interface ChartDescriptiveAnalysis {
 status:"ready"|"unavailable";reason:string|null;contextKey:string;asOf:number|null;coverage:SmartChartSelectedWindow["coverage"];
 basics:ReturnType<typeof chartDescriptiveStats>;
 trend:ObservedMetric<WindowTrend>;distribution:ObservedMetric<WindowDistribution>;latestCloseMidrankPercent:ObservedMetric<number>;
 rsi14:ObservedMetric<number>;roc14Percent:ObservedMetric<number>;atr14:ObservedMetric<number>;atr14PercentOfClose:ObservedMetric<number>;returnStdDevPercent:ObservedMetric<number>;
 unusualMove:ObservedMetric<PriorReturnFlag>;
 cadence:{irregularSteps:number;elapsedGaps:number;largestSeconds:number};summary:string;scope:string;
}
/** Linear interpolation at (N-1)*p (type 7); a within-window descriptive convention. */
export function windowQuantile(sorted:readonly number[],p:number):number|null {
 if(!sorted.length||!Number.isFinite(p)||p<0||p>1)return null;
 for(let i=0;i<sorted.length;i++)if(!Number.isFinite(sorted[i])||(i>0&&sorted[i]!<sorted[i-1]!))return null;
 const at=(sorted.length-1)*p,left=Math.floor(at),fraction=at-left;
 const value=fraction===0?sorted[left]!:sorted[left]!*(1-fraction)+sorted[left+1]!*fraction;
 return Number.isFinite(value)?value:null;
}
function fittedTrend(bars:SmartChartSelectedWindow["bars"],interval:number):ObservedMetric<WindowTrend>{
 if(bars.length<3)return no("At least three closed observations are required for a window fit.");
 const first=bars[0]!,last=bars.at(-1)!,elapsed=(last.time-first.time)/interval;
 const scale=Math.max(...bars.map(b=>b.close));
 if(!Number.isFinite(elapsed)||elapsed<=0||!Number.isFinite(scale)||scale<=0)return no("The time or price scale cannot support a finite fit.");
 // Normalized elapsed time preserves actual gaps; centered normalized prices
 // avoid subtracting large epochs or squaring the original price magnitude.
 const xs=bars.map(b=>(b.time-first.time)/(last.time-first.time)),ys=bars.map(b=>(b.close-first.close)/scale);
 const mx=xs.reduce((sum,x)=>sum+x/bars.length,0),my=ys.reduce((sum,y)=>sum+y/bars.length,0);
 let xx=0,yy=0,xy=0;
 for(let i=0;i<bars.length;i++){const x=xs[i]!-mx,y=ys[i]!-my;xx+=x*x;yy+=y*y;xy+=x*y;}
 if(!Number.isFinite(xx)||xx<=0||![yy,xy].every(Number.isFinite))return no("The observed time or price spread cannot support a finite fit.");
 const delta=xy/xx*scale,slopePerInterval=delta/elapsed,fittedChangePercent=delta/first.close*100;
 let rSquared:number|null=yy===0?null:(xy/Math.sqrt(xx)/Math.sqrt(yy))**2;
 if(rSquared!=null){if(!Number.isFinite(rSquared)||rSquared>1+1e-10||rSquared<0)return no("The fit is outside finite numerical bounds.");rSquared=Math.min(1,rSquared);}
 if(![slopePerInterval,fittedChangePercent].every(Number.isFinite))return no("The window fit exceeds finite numerical bounds.");
 return yes({slopePerInterval,fittedChangePercent,rSquared,elapsedIntervals:elapsed});
}
function returnDeviation(returns:number[]):ObservedMetric<number>{
 if(returns.length<2)return no("At least two adjacent returns are required for return variability.");
 const scale=Math.max(...returns.map(Math.abs));if(scale===0)return yes(0);
 const mean=returns.reduce((s,v)=>s+v/scale/returns.length,0);
 const variance=returns.reduce((s,v)=>s+(v/scale-mean)**2/returns.length,0);
 return number(Math.sqrt(variance)*scale,"Return variability exceeds finite numerical bounds.");
}
function priorReturnFlag(returns:number[]):ObservedMetric<PriorReturnFlag>{
 const prior=returns.slice(Math.max(0,returns.length-121),-1);
 if(prior.length<20)return no(`Needs 20 prior adjacent returns plus the latest; ${prior.length} prior returns are visible.`);
 const sorted=[...prior].sort((a,b)=>a-b),q1=windowQuantile(sorted,.25)!,q3=windowQuantile(sorted,.75)!,iqr=q3-q1;
 if(!Number.isFinite(iqr)||iqr<=0)return no("Prior-return IQR is zero or unavailable; no unusual-move threshold is inferred.");
 const lowerFence=q1-1.5*iqr,upperFence=q3+1.5*iqr,latestReturnPercent=returns.at(-1)!;
 if(![lowerFence,upperFence,latestReturnPercent].every(Number.isFinite))return no("The prior-return threshold exceeds finite numerical bounds.");
 return yes({latestReturnPercent,priorReturns:prior.length,q1,q3,lowerFence,upperFence,position:latestReturnPercent<lowerFence?"below":latestReturnPercent>upperFence?"above":"inside",method:"prior-returns-type7-1.5iqr"});
}
const SCOPE="Describes only the analyzed visible closed candles. RSI/ATR start from this window, so they can differ from full-history studies. Fit and rank are not confidence, significance, prediction or trade instructions.";
/** Same validated viewport/replay selection as patterns; no hidden warmup data. */
export function describeSmartChartWindow(input:SmartChartAnalysisInput):ChartDescriptiveAnalysis {
 const window=selectSmartChartWindow(input),bars=window.bars;
 const unavailable=(reason:string):ChartDescriptiveAnalysis=>({status:"unavailable",reason,contextKey:window.contextKey,asOf:null,coverage:window.coverage,basics:null,
  trend:no(reason),distribution:no(reason),latestCloseMidrankPercent:no(reason),rsi14:no(reason),roc14Percent:no(reason),atr14:no(reason),atr14PercentOfClose:no(reason),returnStdDevPercent:no(reason),unusualMove:no(reason),cadence:{irregularSteps:0,elapsedGaps:0,largestSeconds:0},summary:reason,scope:SCOPE});
 if(window.status!=="ready")return unavailable(window.reason!);
 const basics=chartDescriptiveStats(bars);if(!basics)return unavailable("The visible price descriptors exceed finite numerical bounds.");
 const interval=smartChartIntervalSeconds(input.timeframe)!;
 let irregularSteps=0,elapsedGaps=0,largestSeconds=0;
 for(let i=1;i<bars.length;i++){const step=bars[i]!.time-bars[i-1]!.time;if(Math.abs(step-interval)>.001)irregularSteps++;if(step>interval+.001){elapsedGaps++;largestSeconds=Math.max(largestSeconds,step);}}
 const sorted=bars.map(b=>b.close).sort((a,b)=>a-b),q1=windowQuantile(sorted,.25)!,q3=windowQuantile(sorted,.75)!,iqr=q3-q1;
 const distribution:ObservedMetric<WindowDistribution>=bars.length<4?no("At least four visible closes are required for quartiles."):Number.isFinite(iqr)?yes({q1,median:basics.median,q3,iqr,method:"type7-linear"}):no("Close quartiles exceed finite numerical bounds.");
 const below=sorted.filter(v=>v<basics.last).length,equal=sorted.filter(v=>v===basics.last).length;
 const latestCloseMidrankPercent=number(100*(below+.5*equal)/sorted.length,"Close rank is unavailable.");
 const cadenceReason="Unequal observation intervals are present; missing bars and market closures are not distinguished, so cadence-based metrics are withheld.";
 const rsiReason=`RSI14 needs 15 closed candles; ${bars.length} are in this analyzed window.`,atrReason=`ATR14 needs 14 closed candles; ${bars.length} are in this analyzed window.`,rocReason=`ROC14 needs 15 closed candles; ${bars.length} are in this analyzed window.`;
 const study=(kind:"rsi"|"atr")=>new StudyCalculator({kind,period:14,color:"#000",source:"close",method:"smma"}).calculate(bars).at(-1)?.values[0]??null;
 const rsi14=irregularSteps?no<number>(cadenceReason):number(study("rsi"),rsiReason);
 const atr14=irregularSteps?no<number>(cadenceReason):number(study("atr"),atrReason);
 const atr14PercentOfClose=atr14.status==="available"?number(atr14.value/basics.last*100,"ATR percentage exceeds finite numerical bounds."):no<number>(atr14.reason);
 const roc14Percent=irregularSteps?no<number>(cadenceReason):number(bars.length>=15?(basics.last/bars.at(-15)!.close-1)*100:null,rocReason);
 const returns=bars.slice(1).map((b,i)=>(b.close/bars[i]!.close-1)*100),finiteReturns=returns.every(Number.isFinite);
 const returnReason=irregularSteps?cadenceReason:"Adjacent returns exceed finite numerical bounds.";
 const returnStdDevPercent=irregularSteps||!finiteReturns?no<number>(returnReason):returnDeviation(returns);
 const unusualMove=irregularSteps||!finiteReturns?no<PriorReturnFlag>(returnReason):priorReturnFlag(returns);
 const trend=fittedTrend(bars,interval);
 const rank=latestCloseMidrankPercent.status==="available"?`; its last close sits ${latestCloseMidrankPercent.value<100/3?"in the lower third of":latestCloseMidrankPercent.value>200/3?"in the upper third of":"around the middle of"} this window's closing prices`:"";
 const summary=`Across ${basics.count} closed candles, price ${chartChangeSummary(basics.change,basics.changePercent)}${rank}.`;
 return {status:"ready",reason:null,contextKey:window.contextKey,asOf:window.asOf,coverage:window.coverage,basics,trend,distribution,latestCloseMidrankPercent,rsi14,roc14Percent,atr14,atr14PercentOfClose,returnStdDevPercent,unusualMove,cadence:{irregularSteps,elapsedGaps,largestSeconds},summary,scope:SCOPE};
}
