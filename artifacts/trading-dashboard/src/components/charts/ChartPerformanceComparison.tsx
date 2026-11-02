import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGetChartCandles, getGetChartCandlesQueryKey, type ChartCandlesResponse } from "@workspace/api-client-react";
import { SymbolExplorer } from "@/components/scanner/SymbolExplorer";
import { exactChartSymbol } from "@/lib/chart-engine/chartAnalysisCatalogue";
import { isChartInterval } from "@/lib/chart-engine/chartIntervals";
import { compareChartPerformance, comparisonPaths } from "@/lib/chart-engine/chartPerformanceComparison";
import type { ChartEngineAdapter } from "@/lib/chart-engine/types";
import { readChartStorage, writeChartStorage } from "@/lib/chart-engine/chartWorkspace";

const stamp=(time:number)=>new Date(time*1000).toISOString().replace("T"," ").replace(":00.000Z"," UTC");
const percent=(value:number|null)=>value===null?"No observation":`${value>0?"+":""}${Number(value.toPrecision(5))}%`;
const colors={primary:"#38bdf8",comparison:"#fbbf24"};
const baselinePrice=(value:number)=>Number(value.toPrecision(8)).toString();

/** Optional historical presentation. Reuses the owning chart's range and the
 * shared candle query cache; never writes a setup, symbol bus, or trade ticket. */
export function ChartPerformanceComparison({symbol,timeframe,data,readFailed,adapter,epoch,limit=200,workspaceId="primary",onClose}:{
  symbol:string;timeframe:string;data:ChartCandlesResponse|undefined;readFailed:boolean;
  adapter:ChartEngineAdapter|null;epoch:string|number;limit?:number;workspaceId?:string;onClose:()=>void;
}) {
  // Store only a catalogue selection, never candles, account data or derived
  // authority. Interval/source changes must requalify the fetched observations.
  const storageKey=`arx.chart.price-comparison.v1:${encodeURIComponent(workspaceId)}:${encodeURIComponent(symbol)}`;
  const restored=useMemo(()=>exactChartSymbol(readChartStorage(storageKey),"chart-analysis")?.canonicalSymbol??null,[storageKey]);
  const [choice,setChoice]=useState(()=>({key:storageKey,symbol:restored,saved:true}));
  const current=choice.key===storageKey?choice:{key:storageKey,symbol:restored,saved:true};
  const comparisonSymbol=current.symbol;
  const select=(next:string|null)=>{
    setChoice({key:storageKey,symbol:next,saved:writeChartStorage(storageKey,next)});
    setInspected(null);
  };
  const [range,setRange]=useState<{from:number;to:number}|null>(null);
  const [inspected,setInspected]=useState<number|null>(null);
  const [width,setWidth]=useState(760);
  const plot=useRef<HTMLDivElement>(null);
  const query=useGetChartCandles({symbol:comparisonSymbol??"",timeframe:isChartInterval(timeframe)?timeframe:"M15",limit},{query:{
    queryKey:getGetChartCandlesQueryKey({symbol:comparisonSymbol??"",timeframe:isChartInterval(timeframe)?timeframe:"M15",limit}),
    enabled:comparisonSymbol!==null&&isChartInterval(timeframe),refetchInterval:8000,staleTime:4000,
  }});
  useLayoutEffect(()=>{
    const update=()=>{
      const bars=adapter?.getVisibleCandles?.(),first=bars?.[0],last=bars?.at(-1);
      const next=first&&last?{from:first.time,to:last.time}:null;
      setRange(old=>old?.from===next?.from&&old?.to===next?.to?old:next);
    };
    update();return adapter?.subscribeViewport?.(update);
  },[adapter,epoch,symbol,timeframe]);
  useLayoutEffect(()=>{
    const node=plot.current;if(!node||typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(entries=>{const w=entries[0]?.contentRect.width;if(w&&Number.isFinite(w))setWidth(Math.max(240,w));});
    observer.observe(node);return()=>observer.disconnect();
  },[]);
  const result=useMemo(()=>compareChartPerformance({primary:data,comparison:query.data,primarySymbol:symbol,
    comparisonSymbol:comparisonSymbol??"",timeframe,range,now:Date.now()}),[data,query.data,symbol,comparisonSymbol,timeframe,range]);
  const unavailable=readFailed?`${symbol}: the latest source read failed; comparison withheld.`
    :query.isError?`${comparisonSymbol}: the latest source read failed; comparison withheld.`
    :!comparisonSymbol?"Choose an instrument to compare its closed-bar price change."
    :query.isLoading?"Loading comparison candles…":result.status==="unavailable"?result.reason:null;
  const ready=unavailable===null&&result.status==="ready"?result:null;
  const values=ready?.rows.flatMap(row=>[row.primary,row.comparison].filter((v):v is number=>v!==null))??[0];
  const low=Math.min(0,...values),high=Math.max(0,...values);
  // Scale before subtracting/padding: finite outliers near Number.MAX_VALUE
  // must remain visible without overflowing the plot's coordinate arithmetic.
  const magnitude=Math.max(0.01,Math.abs(low),Math.abs(high));
  const scaledLow=low/magnitude,scaledHigh=high/magnitude,pad=Math.max((scaledHigh-scaledLow)*0.08,0.01);
  const left=68,right=width-12,top=12,bottom=202;
  const start=range?.from??0,end=range?.to??1;
  const x=(time:number)=>left+(time-start)/Math.max(1,end-start)*(right-left);
  const y=(value:number)=>bottom-(value/magnitude-scaledLow+pad)/(scaledHigh-scaledLow+2*pad)*(bottom-top);
  const selected=ready?.rows.find(row=>row.time===inspected)??ready?.lastCommon;
  const selectedIndex=ready&&selected?ready.rows.indexOf(selected):0;
  const selectedText=selected?`${stamp(selected.time)} · ${symbol}: ${percent(selected.primary)} · ${comparisonSymbol}: ${percent(selected.comparison)}`:"";
  return <section aria-label="Percentage comparison" className="space-y-3 border-t border-zinc-800 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Compare price change · {timeframe}</h3><button type="button" onClick={onClose} className="rounded border border-zinc-700 px-3 py-1">Close comparison</button></div>
    <details className="rounded border border-zinc-800 p-2"><summary className="cursor-pointer">Compare {symbol} with {comparisonSymbol??"another instrument"}</summary>
      <SymbolExplorer scope="chart-analysis" activeSymbol={comparisonSymbol??symbol} showDiagnostics={false} onSelect={value=>{
        const exact=exactChartSymbol(value,"chart-analysis");if(exact)select(exact.canonicalSymbol);
      }}/>
      {comparisonSymbol&&<button type="button" className="mt-2 rounded border border-zinc-700 px-3 py-1" onClick={()=>select(null)}>Remove comparison instrument</button>}
    </details>
    {!current.saved&&<p role="alert" className="text-amber-300">This comparison choice is not saved because browser storage is unavailable. It may change when you reopen the chart.</p>}
    <p className="text-zinc-400">Pan or zoom the price chart above to change this window. Both lines start at 0% at their first shared closed bar in view. The horizontal axis uses elapsed UTC time; missing bars stay disconnected. Loaded response history only; no currency conversion, dividends, costs or trading returns.</p>
    {unavailable&&<p role="status" className="text-amber-300">{unavailable}</p>}
    <div ref={plot}>
      {ready&&<>
        <p>Baseline: <time>{stamp(ready.baseline.time)}</time> · {symbol} {baselinePrice(ready.baseline.primary)} · {comparisonSymbol} {baselinePrice(ready.baseline.comparison)} <span className="text-zinc-400">(prices rounded; originals below)</span></p>
        <ul className="my-2 flex flex-wrap gap-x-6 gap-y-1" aria-label="Comparison sources">{(["primary","comparison"] as const).map(key=><li key={key} style={{color:colors[key]}}>{ready[key].symbol} · {ready[key].source} · closed observations{ready[key].stale?" · stale feed":""} · through {stamp(ready[key].lastClosedAt)}</li>)}</ul>
        <svg role="img" aria-label={`Closed-bar percentage change: ${symbol} and ${comparisonSymbol}`} viewBox={`0 0 ${width} 220`} className="w-full" style={{height:220}} onPointerLeave={()=>setInspected(null)} onPointerMove={event=>{
          const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;
          const position=(event.clientX-rect.left)*width/rect.width;
          const nearest=ready.rows.reduce((a,b)=>Math.abs(x(a.time)-position)<=Math.abs(x(b.time)-position)?a:b);
          setInspected(nearest.time);
        }}>
          <title>Historical relative price change; no execution or live-price claim</title>
          {[low,0,high].filter((v,i,a)=>a.indexOf(v)===i).map(value=><g key={value}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="#3f3f46" strokeDasharray={value===0?undefined:"3 3"}/><text x={left-6} y={y(value)+4} textAnchor="end" fill="#a1a1aa" fontSize={11}>{percent(value)}</text></g>)}
          {(["primary","comparison"] as const).map(key=><g key={key} data-comparison-series={key}><path d={comparisonPaths(ready.rows,key,ready.interval,x,y)} fill="none" stroke={colors[key]} strokeWidth={2}/>{ready.rows.map(row=>row[key]===null?null:<circle key={row.time} cx={x(row.time)} cy={y(row[key]!)} r={2} fill={colors[key]}/>)}</g>)}
          {selected&&<line data-comparison-cursor="true" x1={x(selected.time)} x2={x(selected.time)} y1={top} y2={bottom} stroke="#a1a1aa" strokeDasharray="3 3"/>}
        </svg>
        <div className="flex flex-wrap justify-between gap-2 text-zinc-400"><span>{stamp(start)}</span><span>{stamp(end)}</span></div>
        <label className="block">Inspect a closed bar <input type="range" aria-label="Inspect comparison bar" aria-valuetext={selectedText} min={0} max={ready.rows.length-1} step={1} value={Math.max(0,selectedIndex)} className="block w-full" onChange={event=>{
          const index=Number(event.target.value);if(Number.isInteger(index)&&ready.rows[index])setInspected(ready.rows[index]!.time);
        }}/></label>
        <output aria-label="Selected comparison values" aria-live="off" className="block">{selectedText}</output>
        <details><summary className="cursor-pointer">Inspect observed values</summary><p className="break-words">Original baseline closes: {symbol} {ready.baseline.primary} · {comparisonSymbol} {ready.baseline.comparison}</p><div className="max-h-56 overflow-auto"><table className="w-full text-left"><caption>Closed-bar change from the shared baseline</caption><thead><tr><th scope="col">Bar opened (UTC)</th><th scope="col">{symbol}</th><th scope="col">{comparisonSymbol}</th></tr></thead><tbody>{ready.rows.map(row=><tr key={row.time}><th scope="row">{stamp(row.time)}</th><td>{percent(row.primary)}</td><td>{percent(row.comparison)}</td></tr>)}</tbody></table></div></details>
      </>}
    </div>
  </section>;
}
export default ChartPerformanceComparison;
