import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";
import {ARXNativeChart} from "../../artifacts/trading-dashboard/src/components/charts/ARXNativeChart";
import {SmartChartLayout} from "../../artifacts/trading-dashboard/src/components/charts/SmartChartLayout";
// This browser-only fixture cannot open a network stream or execute an order.
class OfflineEventSource { onmessage: any; onerror: any; constructor(){ (window as any).chartStream=this; } close(){} }
(window as any).EventSource=OfflineEventSource;
function Workbench(){
 const [symbol,setSymbol]=useState("EURUSD");
 return <main style={{background:"#09090b",minHeight:"100vh",color:"#fafafa",padding:24}}>
 <h1 style={{fontSize:24,fontWeight:600}}>Smart Chart · Browser acceptance</h1>
 <p style={{color:"#fbbf24",margin:"8px 0 20px"}}>OFFLINE FIXTURE — synthetic candles, no market connection or trading</p>
 <button onClick={()=>setSymbol(s=>s==="EURUSD"?"XAUUSD":"EURUSD")} style={{marginBottom:12}}>Switch instrument</button>
 <SmartChartLayout symbol={symbol}><ARXNativeChart symbol={symbol} limit={5000} height={520} showFeedStatus={false}/></SmartChartLayout>
 </main>;
}
const root=createRoot(document.getElementById("root")!);
root.render(<Workbench/>);
if(import.meta.hot) import.meta.hot.dispose(()=>root.unmount());

// Exposed only by this isolated fixture, never by the shipped application.
(window as any).runChartBenchmark = async (moduleUrl?: string, withStudies = false) => {
 const {LightweightChartsAdapter} = moduleUrl
  ? await import(/* @vite-ignore */ moduleUrl)
  : await import("../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter");
 const el=document.createElement("div"); el.style.cssText="width:1200px;height:500px;position:fixed;left:-2000px;top:0"; document.body.append(el);
 const adapter=new LightweightChartsAdapter(); adapter.init({container:el,height:500});
 const bars=Array.from({length:5000},(_,i)=>({time:1700000000+i*60,open:1.1,high:1.2,low:1.0,close:1.15}));
 const series=(adapter as any).series;
 let replacements=0, updates=0;
 const setData=series.setData.bind(series),update=series.update.bind(series);
 series.setData=(data:any)=>{replacements++;return setData(data);};
 series.update=(data:any)=>{updates++;return update(data);};
 adapter.setCandles(bars);
 if (withStudies) { const {STUDY_DEFAULTS}=await import("../../artifacts/trading-dashboard/src/lib/chart-engine/chartStudies"); adapter.setStudies(STUDY_DEFAULTS); }
 const costs:number[]=[];
 for(let n=0;n<100;n++){
  const next=bars.map(b=>({...b})); next[next.length-1]!.close=1.15+(n%10)*.001;
  const start=performance.now(); adapter.setCandles(next); costs.push(performance.now()-start);
 }
 const tickCosts:number[]=[];
 for(let n=0;n<1000;n++){
  const start=performance.now(); adapter.updateActiveCandle({...bars[bars.length-1]!,close:1.15+(n%10)*.001}); tickCosts.push(performance.now()-start);
 }
 const scale=(adapter as any).chart.timeScale();
 scale.setVisibleLogicalRange({from:1000,to:1100});
 await new Promise(requestAnimationFrame);
 await new Promise(requestAnimationFrame);
 const prepended=Array.from({length:100},(_,i)=>({...bars[0]!,time:bars[0]!.time-(100-i)*60}));
 adapter.setCandles([...prepended,...bars]);
 await new Promise(requestAnimationFrame);
 await new Promise(requestAnimationFrame);
 const range=scale.getVisibleLogicalRange();
 const percentile=(xs:number[],p:number)=>xs.sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)];
 const result={timingScope:"synchronous ingestion; streamed studies are coalesced per frame",withStudies,bars:5000,polls:100,ticks:1000,fullReplacements:replacements,incrementalUpdates:updates,pollP95Ms:percentile(costs,.95),tickP95Ms:percentile(tickCosts,.95),range,historyAnchorPreserved:Math.abs(range.from-1100)<.01&&Math.abs(range.to-1200)<.01};
 adapter.destroy();el.remove();return result;
};

// A visible, paced workload; rAF intervals measure scheduling smoothness, not
// the browser's exact paint completion or an equal-data competitor benchmark.
(window as any).runChartStressBenchmark = async (barCount = 10000) => {
 barCount=Math.min(100000,Math.max(1000,Math.floor(barCount)));
 const {LightweightChartsAdapter}=await import("../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter");
 const {STUDY_CATALOG}=await import("../../artifacts/trading-dashboard/src/lib/chart-engine/chartStudies");
 const el=document.createElement("div");
 el.style.cssText="position:fixed;inset:0;background:#09090b;z-index:99999";
 document.body.append(el);
 const adapter=new LightweightChartsAdapter();
 const frame=()=>new Promise<number>(requestAnimationFrame);
 const longTasks:number[]=[];
 const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>entry.duration)));
 try {observer.observe({type:"longtask",buffered:false});} catch {/* Not supported in every browser. */}
 try {
  const start=performance.now();
  adapter.init({container:el,height:innerHeight});
  const bars=Array.from({length:barCount},(_,i)=>{
   const close=1.1+Math.sin(i/13)*.001;
   return {time:1700000000+i*60,open:close-.0001,high:close+.0003,low:close-.0003,close};
  });
  adapter.setCandles(bars);
  adapter.setStudies(STUDY_CATALOG.slice(0,12).map(item=>({...item.defaults,...(["bollinger","cci"].includes(item.defaults.kind)?{period:1000}:{})})));
  adapter.setDrawings(Array.from({length:40},(_,i)=>({id:`stress-${i}`,kind:"fibonacci" as const,start:{time:bars[barCount-150+i]!.time,price:1.099+i*.00005},end:{time:bars[barCount-50+i]!.time,price:1.101-i*.00004},color:"#fbbf24"})));
  await frame(); await frame();
  const setupToTwoFramesMs=performance.now()-start;
  const costs:number[]=[], totalCosts:number[]=[], frames:number[]=[];
  const analysis=(adapter as any).analysis;
  const originalRefresh=analysis.refresh.bind(analysis);
  let studyCpu=0;
  analysis.refresh=(...args:any[])=>{const start=performance.now();try{return originalRefresh(...args);}finally{studyCpu+=performance.now()-start;}};
  let previous=await frame();
  for(let n=0;n<180;n++) {
   studyCpu=0;
   const begin=performance.now();
   // Co-located updates exercise a burst without modifying historical bars.
   for(let tick=0;tick<10;tick++) adapter.updateActiveCandle({...bars.at(-1)!,close:bars.at(-1)!.close+((n+tick)%10)*.00001});
   const ingestionCpu=performance.now()-begin;costs.push(ingestionCpu);
   const now=await frame();totalCosts.push(ingestionCpu+studyCpu);frames.push(now-previous);previous=now;
  }
  const percentile=(xs:number[],p:number)=>[...xs].sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)];
  return {fixture:"synthetic offline, visible canvas",bars:barCount,studies:12,fibonacciDrawings:40,frames:180,ticks:1800,setupToTwoFramesMs,ingestionCpuP95Ms:percentile(costs,.95),ingestionPlusStudyCpuP95Ms:percentile(totalCosts,.95),ingestionPlusStudyCpuMaxMs:Math.max(...totalCosts),frameIntervalP50Ms:percentile(frames,.5),frameIntervalP95Ms:percentile(frames,.95),frameIntervalMaxMs:Math.max(...frames),longTasksOver50Ms:longTasks};
 } finally { observer.disconnect();adapter.destroy();el.remove(); }
};
