import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";
import {ARXNativeChart} from "../../artifacts/trading-dashboard/src/components/charts/ARXNativeChart";
// This browser-only fixture cannot open a network stream or execute an order.
class OfflineEventSource { onmessage: any; onerror: any; constructor(){ (window as any).chartStream=this; } close(){} }
(window as any).EventSource=OfflineEventSource;
function Workbench(){
 const [symbol,setSymbol]=useState("EURUSD");
 return <main style={{background:"#09090b",minHeight:"100vh",color:"#fafafa",padding:24}}>
 <h1 style={{fontSize:24,fontWeight:600}}>Smart Chart · Browser acceptance</h1>
 <p style={{color:"#fbbf24",margin:"8px 0 20px"}}>OFFLINE FIXTURE — synthetic candles, no market connection or trading</p>
 <button onClick={()=>setSymbol(s=>s==="EURUSD"?"XAUUSD":"EURUSD")} style={{marginBottom:12}}>Switch instrument</button>
 <ARXNativeChart symbol={symbol} limit={5000} height={520} showFeedStatus={false}/>
 </main>;
}
createRoot(document.getElementById("root")!).render(<Workbench/>);

// Exposed only by this isolated fixture, never by the shipped application.
(window as any).runChartBenchmark = async (moduleUrl?: string) => {
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
 const result={bars:5000,polls:100,ticks:1000,fullReplacements:replacements,incrementalUpdates:updates,pollP95Ms:percentile(costs,.95),tickP95Ms:percentile(tickCosts,.95),range,historyAnchorPreserved:Math.abs(range.from-1100)<.01&&Math.abs(range.to-1200)<.01};
 adapter.destroy();el.remove();return result;
};
