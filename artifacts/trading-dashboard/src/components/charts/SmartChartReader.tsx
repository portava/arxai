import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { Sparkles, Eye, EyeOff } from "lucide-react";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartEngineAdapter } from "@/lib/chart-engine";
import type { Candle } from "@/components/scanner/scannerCandleAdapter";
import type { ChartHistoryPage } from "@/lib/chartCandlesQuery";
import { analyzeSmartChart, smartChartIntervalSeconds, type SmartChartAnalysisResult, type SmartChartAnalysisBar, type SmartChartFinding } from "@/lib/chart-engine/smartChartAnalysis";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { chartDescriptiveStats, chartNumber, chartObservationGaps } from "@/lib/chart-engine/chartDescriptiveStats";
import type { ChartPreferences } from "@/lib/chart-engine/chartWorkspace";
import type { SmartChartAnnotation } from "@/lib/chart-engine/smartChartAnnotation";
import { Button } from "@/components/ui/button";

interface Props {adapter:ChartEngineAdapter|null;epoch:number;symbol:string;timeframe:string;data:ChartCandlesResponse|undefined;
  older:readonly Candle[];historyEvidence:ChartHistoryPage["historyEvidence"];liveConfirmed:boolean;readFailed:boolean;view?:Pick<ChartPreferences,"style"|"scale"|"inverted">}
const EMPTY:readonly Candle[]=[];
const statusText={confirmed:"Confirmed by closed candles",developing:"Still developing",invalidated:"No longer valid",observed:"Observed shape"};
export function findingAnnotation(finding:SmartChartFinding|null):SmartChartAnnotation|null {
  if(!finding?.anchors.length)return null;
  const anchors=finding.anchors.slice(0,8).sort((a,b)=>a.time-b.time);
  const neckline=anchors.filter(anchor=>anchor.role.startsWith("neckline_"));
  return {id:finding.id,anchors:anchors.map(anchor=>({time:anchor.time,price:anchor.price,label:anchor.role.replaceAll("_"," ")})),
    ...(neckline.length===2?{guide:{from:neckline[0]!,to:neckline[1]!}}:finding.levels[0]?{level:finding.levels[0]}:{}),color:finding.status==="invalidated"?"#a1a1aa":finding.status==="developing"?"#fbbf24":"#38bdf8",dashed:finding.status!=="confirmed"};
}

/** Explanations live inside the chart frame. A single selected shape owns the
 * automatic annotation layer; detailed readings stay collapsed by default. */
export function SmartChartReader({adapter,epoch,symbol,timeframe,data,older=EMPTY,historyEvidence,liveConfirmed,readFailed,view}:Props) {
  const contextKey=JSON.stringify([symbol,timeframe,data?.marketEvidence?.sourceIdentity,data?.feedStatus?.source]);
  const bound=useMemo(()=>captureSmartChartBars(data,{symbol,timeframe},older,historyEvidence,Date.now()),[data,symbol,timeframe,older,historyEvidence]);
  const [reading,setReading]=useState<{key:string;result:SmartChartAnalysisResult;bars:SmartChartAnalysisBar[];historical:boolean}|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [annotations,setAnnotations]=useState(true);
  const refresh=useCallback(()=>{
    const actual=adapter?.getVisibleCandles?.()??[];
    const byTime=new Map(bound.bars.map(bar=>[bar.time,bar]));
    const observed=actual.flatMap(bar=>{const source=byTime.get(bar.time);return source?[source]:[];});
    const mismatch=actual.some((bar,index)=>{const source=byTime.get(bar.time);
      if(!source)return index!==actual.length-1||bar.time<(bound.bars.at(-1)?.closeTime??Infinity);
      return (["open","high","low","close"] as const).some(key=>source[key]!==bar[key]);});
    const range=actual.length?{from:actual[0]!.time,to:actual.at(-1)!.time}:undefined;
    const historical=!!range&&range.to<(bound.bars.at(-1)?.time??Infinity);
    const result=analyzeSmartChart({...bound.context,bars:actual.length&&!mismatch&&bound.status==="ready"?bound.bars:[],
      visibleRange:range,asOfMs:Date.now(),dataState:!liveConfirmed||readFailed?"stale":historical?"historical":"current"});
    if(bound.status!=="ready"||mismatch||!actual.length){result.status="unavailable";result.findings=[];result.allFindings=[];result.reason=bound.reason??(mismatch?"The displayed candles are updating; analysis will follow the applied chart.":"Waiting for the chart's visible candles.");}
    setReading({key:contextKey,result,bars:observed,historical});
  },[adapter,bound,contextKey,liveConfirmed,readFailed]);
  useLayoutEffect(()=>{
    setSelected(null);refresh();
    return adapter?.subscribeViewport?.(refresh);
  },[adapter,epoch,refresh]);
  const current=reading?.key===contextKey?reading:null;
  const result=current?.result;
  const chosen=result?.allFindings.find(finding=>finding.id===selected)??result?.findings[0]??null;
  const moreFindings=result?.allFindings.filter(finding=>!result.findings.some(summary=>summary.id===finding.id))??[];
  const stats=useMemo(()=>result?.status==="ready"?chartDescriptiveStats(current?.bars??[]):null,[current,result]);
  const gaps=useMemo(()=>result?.status==="ready"?chartObservationGaps(current?.bars??[],smartChartIntervalSeconds(timeframe)??0):null,[current,result,timeframe]);
  useLayoutEffect(()=>{
    adapter?.setSmartAnnotation?.(annotations&&result?.status==="ready"?findingAnnotation(chosen):null);
  },[adapter,epoch,annotations,chosen,result?.status,contextKey]);
  // Clear on ownership changes/unmount, not before every viewport refresh:
  // toggling null between two readings would rebuild hidden server overlays.
  useLayoutEffect(()=>()=>adapter?.setSmartAnnotation?.(null),[adapter,epoch,contextKey]);
  const narrative=chosen?.explanation??(stats?`Price ${stats.change>0?"rose":stats.change<0?"fell":"stayed level"} ${chartNumber(Math.abs(stats.changePercent))}% across ${stats.count} closed candles. The observed range is ${chartNumber(stats.low)} to ${chartNumber(stats.high)}. No clear pattern was found by the available detectors.`:result?.reason??"Waiting for a source-identified chart window.");
  return <section className="border-b border-zinc-800 bg-sky-950/10 px-3 py-2.5 text-xs" aria-label="Automatic chart analysis" data-testid="smart-chart-reader">
    <div className="flex flex-wrap items-center gap-2">
      <Sparkles className="h-3.5 w-3.5 text-sky-300"/><span className="font-semibold text-zinc-100">What the chart is doing</span>
      <span className="text-[10px] text-zinc-400">{current?.historical?"Historical window · ":""}{!liveConfirmed||readFailed?"Stored candles · feed not live-confirmed":"Closed candles only"}</span>
      {view?.inverted&&<span className="text-[10px] text-amber-300">Inverted scale · higher prices appear lower</span>}
      <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1.5 text-[11px]" aria-pressed={annotations} aria-label="Show automatic chart annotations" onClick={()=>setAnnotations(value=>!value)}>{annotations?<Eye className="h-3 w-3"/>:<EyeOff className="h-3 w-3"/>}{annotations?"Annotations on":"Annotations off"}</Button>
    </div>
    {result?.findings.length? <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Relevant chart patterns">{result.findings.map(finding=><button type="button" key={finding.id} className={`rounded border px-2 py-1 text-[11px] ${chosen?.id===finding.id?"border-sky-500/50 bg-sky-500/10 text-sky-200":"border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`} aria-pressed={chosen?.id===finding.id} onClick={()=>setSelected(finding.id)}>{finding.title} · {finding.status}</button>)}</div>:null}
    <p className="mt-2 max-w-[110ch] leading-relaxed text-zinc-200" data-testid="chart-reader-explanation">{narrative}</p>
    <details className="mt-2 text-zinc-400">
      <summary className="w-fit cursor-pointer text-[11px] text-sky-300">Analysis, evidence and chart statistics</summary>
      <div className="mt-3 space-y-3">
        {chosen&&<div className="space-y-1.5"><p className="text-zinc-200">{statusText[chosen.status]} · observed {new Date(chosen.asOf*1000).toISOString().slice(0,19).replace("T"," ")} UTC</p>{chosen.invalidation&&<p>What would change this reading: {chosen.invalidation}</p>}<p>{chosen.caveat}</p></div>}
        {stats&&<dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">{[["Price change",`${chartNumber(stats.change)} (${chartNumber(stats.changePercent)}%)`],["Mean close",chartNumber(stats.mean)],["Median close",chartNumber(stats.median)],["Close variability",chartNumber(stats.stdDev)],["Highest observed price",chartNumber(stats.high)],["Lowest observed price",chartNumber(stats.low)],["Price range",chartNumber(stats.range)],["Close-to-close drawdown",`${chartNumber(stats.maxDrawdownPercent)}%`]].map(([label,value])=><div key={label}><dt className="text-[10px]">{label}</dt><dd className="mt-0.5 font-mono text-zinc-200">{value}</dd></div>)}</dl>}
        <p>{symbol} · {timeframe} · {bound.context.source??"Source unavailable"} · {result?.closedBarsUsed??0} closed candles analyzed. {result?.coverage.note} Statistics describe visible closes; variability is their population standard deviation. Drawdown is a price series measure, not trading P/L.</p>
        {gaps&&<p>{gaps.gaps?`${gaps.gaps} elapsed gap${gaps.gaps===1?"":"s"} between observations; the largest spans ${chartNumber(gaps.largestSeconds/60)} minutes. Market closures or missing intervals may explain these gaps; this view cannot distinguish them.`:"No elapsed gaps between the observed candles in this window."} Missing volume is not treated as zero trading activity.</p>}
        {view&&<p>Display: {view.style} · {view.scale} scale{view.inverted?" · inverted":""}. Readings use the underlying prices and selected period. {view.style==="line"?"The line shows closes; candle patterns also use open, high and low prices.":""}{view.scale!=="linear"?" Axis transformations change visual spacing, not the observed price change.":""}</p>}
        {moreFindings.length>0&&<div className="flex flex-wrap gap-2" aria-label="More observed patterns">{moreFindings.map(finding=><button type="button" key={finding.id} className="rounded border border-zinc-700 px-2 py-1 text-left text-zinc-300" onClick={()=>setSelected(finding.id)}>{finding.title} · {finding.status}</button>)}</div>}
        <p className="text-[10px]">Volume, order flow, forecasts and statistical significance are not inferred from this OHLC window. A pattern alone does not establish causation or a profitable trade.</p>
      </div>
    </details>
  </section>;
}
