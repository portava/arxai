import { LightweightChartsAdapter } from "../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter";
import { STUDY_CATALOG } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartStudies";
import { ChartViewLink } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartViewLink";

/** Isolated renderer workload, never imported by the production app. */
export async function runWorkspaceBenchmark() {
  const host=document.createElement("div");
  host.style.cssText="position:fixed;inset:0;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;background:#09090b;z-index:99999;gap:8px";
  document.body.append(host);
  const adapters:LightweightChartsAdapter[]=[], unlinks:(()=>void)[]=[], links=new ChartViewLink();
  const frame=()=>new Promise<number>(requestAnimationFrame), longTasks:number[]=[];
  const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(item=>item.duration)));
  try {observer.observe({type:"longtask",buffered:false});}catch{/* Optional browser API. */}
  const bars=Array.from({length:5000},(_,i)=>{const close=1.1+Math.sin(i/13)*.001;return{time:1700000000+i*60,open:close-.0001,high:close+.0003,low:close-.0003,close};});
  let studyCpu=0, acceptedUpdates=0;
  try {
    const start=performance.now();
    for(let n=0;n<4;n++) {
      const panel=document.createElement("div");panel.style.cssText="min-width:0;min-height:0";host.append(panel);
      const adapter=new LightweightChartsAdapter();adapters.push(adapter);adapter.init({container:panel,height:(innerHeight-8)/2});adapter.setTimeframe("M1");adapter.setCandles(bars);
      adapter.setStudies(STUDY_CATALOG.slice(0,12).map(item=>({...item.defaults})));
      adapter.setDrawings(Array.from({length:40},(_,i)=>({id:`view-${n}-${i}`,kind:"fibonacci" as const,start:{time:bars[4850+i]!.time,price:1.099+i*.00005},end:{time:bars[4950+i]!.time,price:1.101-i*.00004},color:"#fbbf24"})));
      unlinks.push(links.register(String(n),adapter));
      const series=(adapter as any).series,update=series.update.bind(series);
      series.update=(...args:any[])=>{update(...args);acceptedUpdates++;};
      const analysis=(adapter as any).analysis, refresh=analysis.refresh.bind(analysis);
      analysis.refresh=(...args:any[])=>{const begin=performance.now();try{return refresh(...args);}finally{studyCpu+=performance.now()-begin;}};
    }
    links.configure({crosshair:true,range:true});adapters[0]!.resetScale();
    await frame();await frame();await frame();
    const setupToThreeFramesMs=performance.now()-start;
    const ranges=adapters.map(adapter=>(adapter as any).chart.timeScale().getVisibleRange());
    const rangeAligned=ranges.every(range=>JSON.stringify(range)===JSON.stringify(ranges[0]));
    const frames:number[]=[],costs:number[]=[];let previous=await frame();
    for(let n=0;n<120;n++) {
      studyCpu=0;const begin=performance.now();
      for(const adapter of adapters)for(let tick=0;tick<10;tick++)adapter.updateActiveCandle({...bars.at(-1)!,close:bars.at(-1)!.close+((n+tick)%10)*.00001});
      const ingestion=performance.now()-begin,now=await frame();
      costs.push(ingestion+studyCpu);frames.push(now-previous);previous=now;
    }
    const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*.95)];
    return {fixture:"four visible offline renderers; synthetic candles, no orders or provider",views:4,barsPerView:5000,studiesPerView:12,fibonacciDrawingsPerView:40,frames:120,totalUpdates:4800,acceptedUpdates,rangeAligned,ranges,setupToThreeFramesMs,ingestionPlusStudyCpuP95Ms:p95(costs),frameIntervalP95Ms:p95(frames),frameIntervalMaxMs:Math.max(...frames),longTasksOver50Ms:longTasks};
  } finally {unlinks.forEach(unlink=>unlink());adapters.forEach(adapter=>adapter.destroy());observer.disconnect();host.remove();}
}
