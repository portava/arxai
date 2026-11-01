// Offline native viewport lab. Synthetic data only; no feeds, accounts or orders.
import { NativeChartViewport } from "../../artifacts/trading-dashboard/src/lib/chart-engine/nativeChartViewport";
import { CHART_STYLES, type ChartStyle, type ChartScaleMode, type ChartDrawing } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartWorkspace";
import { STUDY_DEFAULTS, formatStudyNumber } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartStudies";
import { TRADE_VOLUME_AUTHORITY } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartVolume";
import type { ChartEngineCandle } from "../../artifacts/trading-dashboard/src/lib/chart-engine/types";
import { CHART_TIME_ZONES, type ChartTimeZone } from "../../artifacts/trading-dashboard/src/lib/chart-engine/chartTimeZone";

const makeData = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => {
  const j = i + offset, open = 100 + Math.sin(j * .27) * 6 + Math.cos(j * .063) * 8, close = open + Math.sin(j * 1.71) * 2.4;
  return { time: 1_730_613_600 + j * 60, open, high: Math.max(open,close)+1.4, low: Math.min(open,close)-.9, close };
});
document.body.innerHTML = `<main><h1>ARX native chart viewport</h1><p>Independent renderer laboratory · synthetic observations · no broker connection</p><nav><label>Style <select id="style">${CHART_STYLES.map(v=>`<option>${v}</option>`).join("")}</select></label><label>Scale <select id="scale">${["linear","log","percent","indexed"].map(v=>`<option>${v}</option>`).join("")}</select></label><label>Display zone <select id="zone">${CHART_TIME_ZONES.map(v=>`<option>${v}</option>`).join("")}</select></label><label>Studies <select id="studies"><option value="none">None</option><option value="starter">SMA / EMA / BB / RSI / MACD</option><option value="volume">Synthetic volume evidence</option></select></label><label>Drawings <select id="drawings"><option value="none">None</option><option value="sample">Existing ARX tools</option></select></label><button id="place">Place a note</button><button id="withdraw">Withhold volume</button><button id="invert">Invert price axis</button><button id="fit">Fit loaded history</button><button id="latest">Latest</button><button id="reset">Reset 200-bar view</button></nav><output id="state"></output><section id="chart"></section><output id="study-values"></output><output id="inspect">Move over a candle to inspect canonical OHLC.</output><p class="help">Drag to pan · wheel/pinch to zoom · arrow keys to pan · +/− to zoom · Home fits · End follows latest. Display-only; app integration and Scanner overlays are still pending.</p></main>`;
const css=document.createElement("style");css.textContent=`*{box-sizing:border-box}body{margin:0;background:#090f1b;color:#dce7f6;font:14px system-ui}main{max-width:1440px;margin:auto;padding:20px}h1{font-size:24px;margin:0 0 8px}p,output{color:#a3b3c9}nav{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:20px 0}label{display:grid;gap:5px}select,button{padding:9px;background:#17243b;color:inherit;border:1px solid #3a506d;border-radius:5px;font:inherit}#chart{margin:12px 0;background:#0d1625;border:1px solid #20314b;min-width:0}canvas{max-width:100%;outline-offset:-2px}canvas:focus-visible{outline:2px solid #39b7ff}output{white-space:pre-wrap;display:block;overflow-wrap:anywhere;font:12px ui-monospace,monospace}.help{line-height:1.5}@media(max-width:600px){main{padding:12px}h1{font-size:21px}nav{gap:8px}button,select{padding:8px;font-size:12px}}`;document.head.append(css);
let data:ChartEngineCandle[]=makeData(20_000);
const viewport = new NativeChartViewport(document.getElementById("chart")!, {height:500,visibleBars:200,onViewportChange:()=>{
  const state=viewport.getState();document.getElementById("study-values")!.textContent=viewport.getStudyValues(data.at(-1)?.time ?? 0).map(s=>`${s.label}: ${s.reason ?? s.values.map(v=>v.name+" "+(v.value===null?"unavailable":formatStudyNumber(v.value,v.name))).join(" · ")}`).join("\n");document.getElementById("state")!.textContent=`${state.status} · ${state.barCount} loaded bars · ${state.style}/${state.scale} · reference ${state.referencePrice} · ${state.effectiveTimeZone} · ${state.followingLatest?"following latest":"inspecting history"}`;
},onCrosshair:value=>{document.getElementById("inspect")!.textContent=value?`Canonical UTC ${new Date(value.candle.time*1000).toISOString()} | O ${value.candle.open} H ${value.candle.high} L ${value.candle.low} C ${value.candle.close}`:"No candle selected.";}});
const prepareStart=performance.now();viewport.setCandles(data);const initialPreparationMs=performance.now()-prepareStart;
document.getElementById("style")!.addEventListener("change",e=>viewport.setStyle((e.target as HTMLSelectElement).value as ChartStyle));
document.getElementById("scale")!.addEventListener("change",e=>viewport.setScale((e.target as HTMLSelectElement).value as ChartScaleMode));
document.getElementById("zone")!.addEventListener("change",e=>viewport.setDisplayTimeZone((e.target as HTMLSelectElement).value as ChartTimeZone));
document.getElementById("invert")!.addEventListener("click",()=>viewport.setScale(viewport.getState().scale,!viewport.getState().inverted));
document.getElementById("fit")!.addEventListener("click",()=>viewport.fit());document.getElementById("latest")!.addEventListener("click",()=>viewport.goLatest());
document.getElementById("reset")!.addEventListener("click",()=>{viewport.setRange({from:data.length-199,to:data.length+1});viewport.goLatest();});
document.getElementById("studies")!.addEventListener("change",e=>{
  const selection=(e.target as HTMLSelectElement).value;
  if(selection==="volume"){
    const identity="a".repeat(64);
    data=data.map((bar,i)=>({...bar,volumeEvidence:{kind:"real_volume",unit:"provider_trade_units",quantity:100+i%41,reason:null,authority:TRADE_VOLUME_AUTHORITY,seriesIdentity:identity},profileEvidence:{finality:"closed",clockAuthority:TRADE_VOLUME_AUTHORITY}}));
    viewport.setCandles(data);
    const from=data[Math.max(0,data.length-200)]!.time,to=data.at(-1)!.time;
    viewport.setStudies([{kind:"vwap",period:1,color:"#fbbf24",vwapAnchor:{kind:"observed_bar",time:from,seriesIdentity:identity}},
      {kind:"trade_volume",period:1,color:"#34d399"},
      {kind:"volume_profile",period:1,color:"#a78bfa",profileRows:24,profileValueAreaPercent:70,profileRange:{kind:"observed_range",fromTime:from,toTime:to,seriesIdentity:identity,clockAuthority:TRADE_VOLUME_AUTHORITY}}]);
  }else viewport.setStudies(selection==="starter"?STUDY_DEFAULTS:[]);
});
document.getElementById("withdraw")!.addEventListener("click",()=>{data=data.map(({volumeEvidence:_v,profileEvidence:_p,...bar})=>bar);viewport.setCandles(data);});
let drawingCommits:ChartDrawing[][]=[];
let drawingSelection:string|null=null;
let history:ChartDrawing[][]=[],future:ChartDrawing[][]=[];
const bindDrawingInteraction=()=>viewport.setDrawingInteraction({selectedId:drawingSelection,snap:false,
  onSelect:id=>{drawingSelection=id;},
  onCommit:next=>{drawingCommits.push(next);history.push(next);future=[];},
  onUndo:()=>{if(history.length>1){future.push(history.pop()!);viewport.setDrawings(history.at(-1)!);}},
  onRedo:()=>{const next=future.pop();if(next){history.push(next);viewport.setDrawings(next);}},
});
const sampleDrawings=():ChartDrawing[]=>{
 const bar=(n:number)=>data[data.length-n]!,a=bar(160),b=bar(80);
 return [
  {id:"level",kind:"horizontal",start:{time:a.time,price:a.low},color:"#fbbf24"},
  {id:"trend",kind:"trend",start:{time:a.time,price:a.high},end:{time:b.time,price:b.high},color:"#38bdf8",width:2},
  {id:"channel",kind:"channel",start:{time:bar(110).time,price:bar(110).high},end:{time:bar(40).time,price:bar(40).high},offset:{time:bar(110).time,price:bar(110).low},color:"#a78bfa",middleLine:true},
  {id:"note",kind:"text",start:{time:bar(50).time,price:bar(50).low},color:"#34d399",text:"Your chart note. Synthetic observations only."},
  {id:"ruler",kind:"measure",start:{time:bar(185).time,price:bar(185).high},end:{time:bar(170).time,price:bar(170).low},color:"#fb7185"},
 ];
};
document.getElementById("drawings")!.addEventListener("change",e=>{
 const next=(e.target as HTMLSelectElement).value==="sample"?sampleDrawings():[];
 viewport.setDrawings(next);history=[next];future=[];drawingSelection=null;bindDrawingInteraction();
});
document.getElementById("place")!.addEventListener("click",()=>{
 viewport.setDrawingHandler(anchor=>{const next=[...viewport.getDrawings(),{id:"note-"+performance.now(),kind:"text" as const,start:anchor,color:"#34d399",text:"Your note"}];viewport.setDrawings(next);history.push(next);viewport.setDrawingHandler(null);});
});
const waitPaint=async(previous:number)=>{for(let i=0;i<20;i++){await new Promise(requestAnimationFrame);if(viewport.getState().paintCount>previous)return;}throw Error("Viewport did not paint");};
(window as any).__arxNativeViewportQa={viewport,makeData,sampleDrawings,get drawingCommits(){return drawingCommits;},bindDrawingInteraction,get data(){return data;},replace:(next:typeof data)=>{data=next;viewport.setCandles(data);},waitPaint,initialPreparationMs,
  benchmark:async()=>{
    const samples:number[]=[];viewport.setStyle("candles");viewport.setScale("linear",false);
    // Request-to-completed RAF Canvas submission, not physical display latency.
    for(let i=0;i<150;i++){const previous=viewport.getState().paintCount,begin=performance.now();viewport.setRange({from:data.length-201-(i%10),to:data.length-1-(i%10)});await waitPaint(previous);if(i>=30)samples.push(performance.now()-begin);}
    return {samples,warmup:30,loadedBars:data.length,visibleLogicalSpan:200,initialPreparationMs,dpr:devicePixelRatio,userAgent:navigator.userAgent};
  },
};
