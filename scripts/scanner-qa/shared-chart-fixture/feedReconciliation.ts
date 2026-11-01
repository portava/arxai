// QA-only entry. Real production adapter and renderer; no application/API mount.
import type { ChartEngineCandle } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/types";
import type { ChartStyle } from "../../../artifacts/trading-dashboard/src/lib/chart-engine/chartWorkspace";
const STYLES: ChartStyle[] = ["candles", "hollow", "bars", "line", "area", "baseline", "heikinAshi"];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const frame = () => new Promise<void>((resolve,reject) => {
  const timeout=setTimeout(()=>{cancelAnimationFrame(id);reject(Error("Rendering opportunity exceeded 2 seconds"));},2000);
  const id=requestAnimationFrame(()=>{clearTimeout(timeout);resolve();});
});
const ohlc = (bar: any) => ({time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close});
function expectedDisplay(bars: ChartEngineCandle[], style: ChartStyle) {
  if (["line", "area", "baseline"].includes(style)) return bars.map(bar=>({time:bar.time,value:bar.close}));
  if (style!=="heikinAshi") return bars.map(ohlc);
  const result: ChartEngineCandle[]=[];
  for (const bar of bars) {
    const prior=result.at(-1);
    const open=prior?(prior.open+prior.close)/2:(bar.open+bar.close)/2;
    const close=(bar.open+bar.high+bar.low+bar.close)/4;
    result.push({time:bar.time,open,close,high:Math.max(bar.high,open,close),low:Math.min(bar.low,open,close)});
  }
  return result.map(ohlc);
}
function assert(value: unknown, reason: string): asserts value { if(!value)throw Error(reason); }
export function installFeedReconciliationProbe(Adapter: new()=>any) {
  let running=false;
  Object.defineProperty(window,"__arxFeedReconciliationQa",{value:{schemaVersion:1,async run(){
    assert(!running,"Probe already running"); running=true;
    const report:any={passed:false,samples:[],warmups:[],checks:[],failure:null,styles:STYLES,
      workload:{bars:500,warmupCycles:2,measuredCycles:12,operationsPerSample:1,order:["identical","tail","stale","live"],maximumRunMs:60000},
      limitations:["Isolated adapter, not actual Scanner navigation or app polling.","Synthetic OHLC; feed live flag is fixture-controlled, not verified market provenance.","CPU duration includes method counters; frame duration includes immediate validation and two rendering opportunities, not physical paint.","12 samples per scenario/style/rate; p95 is not a stable production estimate.","No vendor transforms, external API, trading or worker."]};
    const container=document.createElement("div");container.dataset.testid="feed-reconciliation-canvas";
    Object.assign(container.style,{width:"100%",height:"600px",margin:"12px 0"});
    const title=document.createElement("h1");title.textContent="ARX offline feed reconciliation — synthetic prices";
    const root=document.getElementById("root")!;root.replaceChildren(title,container);
    const adapter=new Adapter(); const restores:(()=>void)[]=[];
    let activeCounts:any=null;
    const patch=(owner:any,key:string,fn:(original:any,args:any[])=>any)=>{
      const original=owner[key];owner[key]=function(...args:any[]){return fn(original.bind(this),args);};
      restores.push(()=>{owner[key]=original;});
    };
    const patchedLines=new WeakSet<object>();
    const instrumentLine=(line:any)=>{
      if(patchedLines.has(line))return;patchedLines.add(line);
      patch(line,"applyOptions",(original,args)=>{if(activeCounts)activeCounts.lastLineApplyOptions++;return original(...args);});
    };
    const inspect=(bars:ChartEngineCandle[],style:ChartStyle,live:boolean,source:string)=>{
      const series=adapter.series,options=series.options(),lines=series.priceLines().filter((line:any)=>line.options().title==="Last");
      assert(JSON.stringify(adapter.candles.map(ohlc))===JSON.stringify(bars.map(ohlc)),"Canonical candle mismatch");
      const display=series.data().map((bar:any)=>["line","area","baseline"].includes(style)?{time:bar.time,value:bar.value}:ohlc(bar));
      assert(JSON.stringify(display)===JSON.stringify(expectedDisplay(bars,style)),"Actual series data mismatch");
      const expectedLabel=live&&style!=="heikinAshi";
      assert(options.lastValueVisible===expectedLabel&&options.priceLineVisible===expectedLabel,"Actual label flags mismatch");
      assert(lines.length===(live&&bars.length?1:0),"Actual Last line count mismatch");
      if(lines.length){assert(lines[0].options().price===bars.at(-1)!.close,"Last line price is not canonical close");assert(lines[0].options().axisLabelVisible===true,"Last axis label hidden");}
      assert(adapter.feedState.source===source&&adapter.feedState.livePriceAffordance===live,"Feed context mismatch");
      const box=container.getBoundingClientRect();
      const visible=box.width>=100&&box.height>=100&&box.bottom>0&&box.top<innerHeight;
      assert(visible&&container.querySelectorAll("canvas").length>0,"No visible real canvas");
      return {style,source,live,barCount:bars.length,last:bars.at(-1)??null,lastValueVisible:options.lastValueVisible,
        priceLineVisible:options.priceLineVisible,lastLine:lines[0]?.options().price??null,displayLast:display.at(-1)??null,
        visibleCanvas:true,canonicalAndDisplayMatched:true};
    };
    const runStart=performance.now();
    try {
      adapter.init({container,height:600});adapter.setSymbol("EURUSD");adapter.setTimeframe("M1");
      let bars:ChartEngineCandle[]=Array.from({length:500},(_,i)=>({time:1700000000+i*60,open:1.1+i*.00001,high:1.102+i*.00001,low:1.098+i*.00001,close:1.101+i*.00001}));
      adapter.setFeedState({source:"offline_fixture_A",livePriceAffordance:true});adapter.setCandles(clone(bars));
      await frame();await frame();
      for(const style of STYLES){
        adapter.setChartStyle(style);adapter.setFeedState({source:"offline_fixture_A",livePriceAffordance:true});adapter.setCandles(clone(bars));
        await frame();await frame();
        const series=adapter.series;
        patch(series,"applyOptions",(original,args)=>{if(activeCounts){activeCounts.seriesApplyOptions++;if("lastValueVisible"in args[0]||"priceLineVisible"in args[0])activeCounts.labelApplyOptions++;}return original(...args);});
        patch(series,"createPriceLine",(original,args)=>{const line=original(...args);if(args[0].title==="Last"){if(activeCounts)activeCounts.createLast++;instrumentLine(line);}return line;});
        patch(series,"removePriceLine",(original,args)=>{if(activeCounts&&args[0].options().title==="Last")activeCounts.removeLast++;return original(...args);});
        for(const line of series.priceLines())if(line.options().title==="Last")instrumentLine(line);
        report.checks.push(inspect(bars,style,true,"offline_fixture_A"));
        for(let cycle=0;cycle<14;cycle++)for(const scenario of ["identical","tail","stale","live"]){
          assert(performance.now()-runStart<60000,"Probe exceeded declared 60 second bound");
          if(scenario==="tail"){bars=clone(bars);bars[bars.length-1]!.close+=.000001;}
          const input=clone(bars),live=scenario!=="stale";
          const counts={seriesApplyOptions:0,labelApplyOptions:0,lastLineApplyOptions:0,createLast:0,removeLast:0};
          activeCounts=counts;const start=performance.now();
          adapter.setFeedState({source:"offline_fixture_A",livePriceAffordance:live});adapter.setCandles(input);
          const cpuMs=performance.now()-start;activeCounts=null;
          // The stop point is method completion. Validation is outside CPU timing.
          const immediate=inspect(bars,style,live,"offline_fixture_A");
          await frame();await frame();
          const framesMs=performance.now()-start;
          const completed=inspect(bars,style,live,"offline_fixture_A");
          const sample={style,scenario,cycle,cpuMs,twoFramesMs:framesMs,counts,immediate,completed};
          (cycle<2?report.warmups:report.samples).push(sample);
        }
        // Correctness-only source change and empty/refill; never timed as speed.
        // An external options edit cannot be hidden by an adapter-side cache.
        series.applyOptions({lastValueVisible:style==="heikinAshi",priceLineVisible:style==="heikinAshi"});
        adapter.setFeedState({source:"offline_fixture_A",livePriceAffordance:true});
        report.checks.push(inspect(bars,style,true,"offline_fixture_A"));
        const streamed={...bars.at(-1)!,time:bars.at(-1)!.time+60,close:bars.at(-1)!.close+.00001};adapter.updateActiveCandle(streamed);
        adapter.setFeedState({source:"offline_fixture_A",livePriceAffordance:true});adapter.setCandles(clone(bars));
        report.checks.push(inspect([...bars,streamed],style,true,"offline_fixture_A"));
        adapter.setFeedState({source:"offline_fixture_B",livePriceAffordance:false});adapter.setCandles(clone(bars));
        report.checks.push(inspect(bars,style,false,"offline_fixture_B"));
        adapter.setFeedState({source:"offline_fixture_B",livePriceAffordance:true});adapter.setCandles([]);
        report.checks.push(inspect([],style,true,"offline_fixture_B"));
        adapter.setCandles(clone(bars));report.checks.push(inspect(bars,style,true,"offline_fixture_B"));
      }
      report.passed=true;
    }catch(error){report.failure=String(error);}finally{
      activeCounts=null;for(const restore of restores.reverse())restore();adapter.destroy();running=false;
    }
    return report;
  }},writable:false,configurable:false});
}
