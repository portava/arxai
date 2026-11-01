import { LightweightChartsAdapter } from "../../artifacts/trading-dashboard/src/lib/chart-engine/lightweightChartsAdapter";
import { StudyCalculator, STUDY_CATALOG } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartStudies";
import { ChartViewLink } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartViewLink";

/** Offline renderer stress only, not an application route or a broker workload.
 * Full output validation follows the measured window and is not timed as UI work. */
export async function runStressMatrixCase({bars:barCount,views,frames:frameCount=180}: {bars:number;views:1|4;frames?:number}) {
  if (![5000,10000,50000].includes(barCount) || ![1,4].includes(views) || frameCount!==180) throw Error("Use a declared matrix workload");
  const frame=()=>new Promise<number>(requestAnimationFrame);
  const host=document.createElement("div");host.style.cssText=`position:fixed;inset:0;padding-top:24px;display:grid;grid-template-columns:repeat(${views===4?2:1},minmax(0,1fr));grid-template-rows:repeat(${views===4?2:1},minmax(0,1fr));gap:8px;background:#09090b;z-index:99999`;
  const label=document.createElement("div");label.textContent="OFFLINE RENDERER STRESS — synthetic history, no broker or orders";label.style.cssText="position:absolute;top:0;left:4px;color:#fbbf24;font:12px sans-serif";host.append(label);document.body.append(host);
  const adapters:LightweightChartsAdapter[]=[],panels:HTMLElement[]=[],unlinks:(()=>void)[]=[],links=new ChartViewLink();
  const longTasks:{start:number;duration:number}[]=[];
  const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));
  let longTaskSupported=true;try{observer.observe({type:"longtask",buffered:false});}catch{longTaskSupported=false;}
  const bar=(i:number)=>{const close=1.1+Math.sin(i/13)*.001;return{time:1700000000+i*60,open:close-.0001,high:close+.0003,low:close-.0003,close};};
  const source=Array.from({length:barCount},(_,i)=>bar(i));
  const configs=STUDY_CATALOG.slice(0,12).map(item=>({...item.defaults,...(["bollinger","cci"].includes(item.defaults.kind)?{period:1000}:{})}));
  let acceptedUpdates=0,studyCpu=0,synchronous=false;
  try{
    const setupStart=performance.now();
    for(let i=0;i<views;i++){
      const panel=document.createElement("div");panel.style.cssText="min-width:0;min-height:0";host.append(panel);panels.push(panel);
      const adapter=new LightweightChartsAdapter();adapters.push(adapter);adapter.init({container:panel,height:(innerHeight-24-(views===4?8:0))/(views===4?2:1)});adapter.setTimeframe("M1");adapter.setCandles(source);adapter.setStudies(configs);
      adapter.setDrawings(Array.from({length:40},(_,j)=>({id:`${i}-${j}`,kind:j%2?"fibonacci" as const:"measure" as const,start:{time:source[barCount-150+j]!.time,price:1.099+j*.00005},end:{time:source[barCount-50+j]!.time,price:1.101-j*.00004},color:"#fbbf24"})));
      unlinks.push(links.register(String(i),adapter));
      const internal=adapter as any,update=internal.series.update.bind(internal.series),refresh=internal.analysis.refresh.bind(internal.analysis);
      internal.series.update=(...args:any[])=>{const value=update(...args);acceptedUpdates++;return value;};
      internal.analysis.refresh=(...args:any[])=>{const start=performance.now();try{return refresh(...args);}finally{if(!synchronous)studyCpu+=performance.now()-start;}};
    }
    links.configure({crosshair:true,range:true});adapters[0]!.resetScale();await frame();await frame();await frame();
    const setupToThreeFramesMs=performance.now()-setupStart;
    const visibility=panels.map(panel=>{const b=panel.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return b.width>=100&&b.height>=100&&b.top>=0&&b.bottom<=innerHeight+1&&b.left>=0&&b.right<=innerWidth+1&&!!hit&&panel.contains(hit);});
    const samples:{frame:number;intervalMs:number;ingestionMs:number;studyMs:number}[]=[];let previous=await frame();
    const streamStart=performance.now();
    for(let n=0;n<frameCount;n++){
      studyCpu=0;synchronous=true;const start=performance.now();
      for(const adapter of adapters)for(let tick=0;tick<10;tick++)adapter.updateActiveCandle({...bar(barCount-1),close:bar(barCount-1).close+((n+tick)%10)*.00001});
      if(n%30===0){adapters[0]!.panBy(n%60===0?-.15:.15);adapters[0]!.zoomBy(n%60===0?.9:1/.9);}
      const ingestionMs=performance.now()-start;synchronous=false;const now=await frame();samples.push({frame:n,intervalMs:now-previous,ingestionMs,studyMs:studyCpu});previous=now;
    }
    await frame();await frame();await frame();const measuredEnd=performance.now();
    longTasks.push(...observer.takeRecords().map(e=>({start:e.startTime,duration:e.duration})));observer.disconnect();
    const expected=Array.from({length:barCount},(_,i)=>bar(i));expected[barCount-1]!.close+=((frameCount-1+9)%10)*.00001;
    const canonical=(rows:any[])=>rows.map(({time,open,high,low,close})=>({time,open,high,low,close}));
    const expectedJson=JSON.stringify(expected),correctness:any[]=[];
    const fullPoints=configs.map(config=>{const calculator=new StudyCalculator(config);calculator.calculate(expected,0,false);return calculator.points;});
    for(const adapter of adapters){
      const internal=adapter as any,analysis=internal.analysis,logical=internal.chart.timeScale().getVisibleLogicalRange();
      const from=Math.max(0,Math.ceil(logical.from)),to=Math.min(barCount-1,Math.floor(logical.to));
      const renderedStudies=analysis.studies.every((handle:any,index:number)=>handle.lines.every((line:any,channel:number)=>{
        const rows=line.data(),times=new Set(rows.map((row:any)=>row.time));
        if(rows.length!==times.size || rows.length===0)return false;
        for(let i=from;i<=to;i++)if(!times.has(expected[i]!.time))return false;
        return rows.every((row:any)=>{const i=(row.time-1700000000)/60,point=Number.isInteger(i)?fullPoints[index]?.[i]:null;
          if(!point || point.time!==row.time)return false;const value=point.values[channel];
          return value==null || !Number.isFinite(value) ? row.value===undefined : row.value===value;
        });
      }));
      correctness.push({canonical:JSON.stringify(canonical(internal.candles))===expectedJson,display:JSON.stringify(canonical(internal.series.data()))===expectedJson,
        renderedStudies,studies:analysis.studies.length===configs.length&&analysis.studies.every((handle:any,index:number)=>JSON.stringify(handle.calculator.points)===JSON.stringify(fullPoints[index])),
        drawings:analysis.drawings.length===40,rulerCount:analysis.drawings.filter((d:any)=>d.kind==="measure").length,range:internal.chart.timeScale().getVisibleRange()});
    }
    const rangeAligned=correctness.every(c=>JSON.stringify(c.range)===JSON.stringify(correctness[0].range));
    const p=(values:number[],fraction:number)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*fraction)]!;
    const intervalP95Ms=p(samples.map(s=>s.intervalMs),.95);
    return{workload:{bars:barCount,views,frames:frameCount,ticksPerFramePerView:10,studies:configs,drawingsPerView:{fibonacci:20,ruler:20}},
      setupToThreeFramesMs,setupStart,streamStart,measuredEnd,acceptedUpdates,expectedUpdates:views*frameCount*10,visibility,rangeAligned,correctness,
      valid:visibility.every(Boolean)&&rangeAligned&&acceptedUpdates===views*frameCount*10&&correctness.every(c=>c.canonical&&c.display&&c.studies&&c.renderedStudies&&c.drawings&&c.rulerCount===20),
      frameIntervalP50Ms:p(samples.map(s=>s.intervalMs),.5),frameIntervalP95Ms:intervalP95Ms,frameIntervalMaxMs:Math.max(...samples.map(s=>s.intervalMs)),
      meetsFrameProxy:intervalP95Ms<=16.7+1e-6,frameProxyBudgetMs:16.7,ingestionPlusStudyP95Ms:p(samples.map(s=>s.ingestionMs+s.studyMs),.95),
      samples,longTaskSupported,longTasks,limits:["Renderer-only synthetic workload; not Scanner navigation or trusted pointer latency","rAF spacing is not physical paint or proof of sustained60fps","Full study oracle shares the calculator; tests independently establish formulas","No competitor runtime measurement"]};
  }finally{observer.disconnect();unlinks.forEach(fn=>fn());adapters.forEach(a=>a.destroy());host.remove();}
}
