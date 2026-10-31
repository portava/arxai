import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>{
  const handles:any[]=[];
  const range={from:10,to:30};
  const scale={subscribeVisibleLogicalRangeChange:vi.fn(),getVisibleLogicalRange:()=>range,setVisibleLogicalRange:vi.fn(),setVisibleRange:vi.fn(),fitContent:vi.fn(),width:()=>800,coordinateToTime:vi.fn(()=>100),scrollToPosition:vi.fn(),scrollToRealTime:vi.fn(),options:()=>({rightOffset:8})};
  const chart={addSeries:vi.fn((kind:any,options:any,pane=0)=>{const data:any[]=[];const handle={kind,options,pane,data,
    setData:vi.fn((next:any[])=>data.splice(0,data.length,...next.map(point=>({...point})))),
    update:vi.fn((point:any)=>{const last=data.at(-1);if(last&&point.time<last.time)throw new Error('Historical update');if(last?.time===point.time)data[data.length-1]={...point};else data.push({...point});}),
    pop:vi.fn((count:number)=>{for(let i=data.length-1;i>=0&&count>0;i--)if(data[i].value!=null||data[i].close!=null){data.splice(i,1);count--;}}),applyOptions:vi.fn(),createPriceLine:vi.fn(()=>({applyOptions:vi.fn()})),removePriceLine:vi.fn(),coordinateToPrice:()=>1.2,attachPrimitive:vi.fn(),detachPrimitive:vi.fn()};handles.push(handle);return handle;}),removeSeries:vi.fn(),subscribeClick:vi.fn(),subscribeCrosshairMove:vi.fn(),timeScale:()=>scale,applyOptions:vi.fn(),remove:vi.fn(),clearCrosshairPosition:vi.fn(),panes:()=>Array.from({length:4},()=>({setHeight:vi.fn(),setStretchFactor:vi.fn(),getHeight:()=>300}))};
  return{chart,handles,scale};
});
vi.mock("lightweight-charts",()=>({createChart:()=>m.chart,CandlestickSeries:"candles",BarSeries:"bars",LineSeries:"line",AreaSeries:"area",BaselineSeries:"baseline",HistogramSeries:"histogram",createSeriesMarkers:()=>({detach:vi.fn()}),ColorType:{Solid:"solid"},CrosshairMode:{Normal:0},LineStyle:{Dashed:2,Solid:0},PriceScaleMode:{Normal:0,Logarithmic:1}}));
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import { STUDY_DEFAULTS, STUDY_CATALOG, StudyCalculator } from "./chartStudies";
import { heikinAshi, hollowPoint } from "./heikinAshi";
import type { ChartStyle } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";
const bars=Array.from({length:100},(_,i)=>({time:100+i*60,open:1,high:2,low:1,close:1.5+Math.sin(i)*.1}));
let adapter:LightweightChartsAdapter;
let container:HTMLDivElement;
beforeEach(()=>{Object.assign(m.scale.getVisibleLogicalRange(),{from:10,to:30});vi.clearAllMocks();m.handles.length=0;vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});adapter=new LightweightChartsAdapter();container=document.createElement("div");document.body.append(container);adapter.init({container,height:500});adapter.setCandles(bars);});
afterEach(()=>{adapter.destroy();container.remove();});
describe("Smart Chart studies, styles and drawing ownership",()=>{
  it("resets all context-owned geometry and stream state without destroying the canvas",()=>{
    adapter.setStudies(STUDY_DEFAULTS);
    adapter.setDrawings([{id:"old",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"}]);
    adapter.setSmartAnnotation({id:"old",anchors:[{time:100,price:1.2,label:"old"}],color:"#ffffff",dashed:false});
    adapter.updateActiveCandle({...bars.at(-1)!,time:bars.at(-1)!.time+60});
    adapter.setNavigationMode("pan");
    m.chart.applyOptions({rightPriceScale:{autoScale:false}});
    const price=m.handles[0];adapter.resetDataContext();
    expect(m.chart.remove).not.toHaveBeenCalled();expect(price.setData).toHaveBeenLastCalledWith([]);
    expect(adapter.getVisibleCandles()).toEqual([]);expect((adapter as any).streamTip).toBeNull();
    expect((adapter as any).smartAnnotation).toBeNull();expect((adapter as any).didFit).toBe(false);
    expect(m.chart.clearCrosshairPosition).toHaveBeenCalledOnce();expect(container.dataset.chartNavigation).toBe("inspect");
    expect(m.chart.applyOptions).toHaveBeenLastCalledWith({rightPriceScale:{autoScale:true}});
    const replacement=bars.slice(0,40).map(b=>({...b,open:10,high:12,low:9,close:11}));
    adapter.setCandles(replacement);
    expect((adapter as any).candles).toEqual(replacement);expect((adapter as any).didFit).toBe(true);
    expect((adapter as any).analysis).not.toBeNull();
  });
  it("navigates the actual viewport without rewriting candle data",()=>{
    const price=m.handles[0], before=price.setData.mock.calls.length;
    expect(adapter.panBy(-0.25)).toBe(true);
    expect(m.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:5,to:25});
    expect(adapter.zoomBy(0.75)).toBe(true);
    expect(m.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:12.5,to:27.5});
    expect(price.setData).toHaveBeenCalledTimes(before);
    const visible=adapter.getVisibleCandles();
    expect(visible).toEqual(bars.slice(10,31));
    visible[0]!.close=99;
    expect(adapter.getVisibleCandles()[0]!.close).toBe(bars[10]!.close);
  });
  it("hand mode cannot place drawings and restores the prior tool on inspection",()=>{
    const handler=vi.fn();adapter.setDrawingHandler(handler);
    const canvas=document.createElement("canvas");container.append(canvas);
    const click=()=>{canvas.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:100,clientY:50}));canvas.dispatchEvent(new MouseEvent("pointerup",{bubbles:true,clientX:100,clientY:50}));};
    adapter.setNavigationMode("pan");click();
    expect(handler).not.toHaveBeenCalled();
    expect(container.dataset.chartNavigation).toBe("pan");
    expect(m.chart.applyOptions).toHaveBeenLastCalledWith({handleScroll:true});
    adapter.setNavigationMode("inspect");click();
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("keeps automatic annotations separate from saved drawings and suppresses competing structure",()=>{
    adapter.setDrawings([{id:"saved",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"}]);
    const price=m.handles[0],drawing=price.attachPrimitive.mock.calls[0][0];
    const line={id:"structure",start:{time:100,price:1.3},end:{time:160,price:1.4},color:"#ffffff",dashed:false,width:1};
    adapter.setStructureLines([line],[]);const structure=m.handles.at(-1);
    const annotation={id:"doji",anchors:[{time:100,price:1.5,label:"Doji"}],color:"#38bdf8",dashed:true};
    adapter.setSmartAnnotation(annotation);const automatic=price.attachPrimitive.mock.calls.at(-1)[0];
    expect(m.chart.removeSeries).toHaveBeenCalledWith(structure);
    expect(drawing.drawings).toHaveLength(1);expect(automatic).not.toBe(drawing);
    const count=m.chart.addSeries.mock.calls.length;
    adapter.setSmartAnnotation({...annotation});adapter.setStructureLines([line],[]);
    expect(m.chart.addSeries).toHaveBeenCalledTimes(count);
    adapter.setChartStyle("line");expect(m.handles.at(-1).attachPrimitive).toHaveBeenCalledWith(automatic);
    adapter.setSmartAnnotation(null);expect(m.chart.addSeries.mock.calls.length).toBeGreaterThan(count);
    expect(drawing.drawings).toHaveLength(1);
  });
  it("keeps studies incremental and independent of style switches and live-price truth",()=>{
    adapter.setStudies(STUDY_DEFAULTS);const studies=m.handles.slice(1);
    expect(studies).toHaveLength(9);expect(studies.filter(s=>s.pane===1)).toHaveLength(1);expect(studies.filter(s=>s.pane===2)).toHaveLength(3);
    adapter.updateActiveCandle({...bars.at(-1)!,close:1.7});
    adapter.getStudyValues(bars.at(-1)!.time); // inspection flushes the pending frame
    for(const study of studies){expect(study.setData).toHaveBeenCalledTimes(1);expect(study.update).toHaveBeenCalledTimes(1);}
    adapter.setChartStyle("line");const price=m.handles.at(-1);
    expect(price.setData.mock.calls[0][0].at(-1)).toEqual({time:bars.at(-1)!.time,value:1.7});
    expect(price.applyOptions).toHaveBeenCalledWith({priceLineVisible:false,lastValueVisible:false});
    expect(m.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:10,to:30});
    adapter.setStudies([]);expect(m.chart.removeSeries).not.toHaveBeenCalledWith(price);
    for(const study of studies)expect(m.chart.removeSeries).toHaveBeenCalledWith(study);
  });
  it("inspects indicator values by the same candle from every pane", () => {
    adapter.setStudies([{...STUDY_DEFAULTS[0]!, id:"first", period:2}, {...STUDY_DEFAULTS[0]!, id:"second", period:20}, STUDY_DEFAULTS[3]!]);
    expect(adapter.getStudyValues(bars[0]!.time).map(row=>row.values[0]!.value)).toEqual([null,null,null]);
    const last = adapter.getStudyValues(bars.at(-1)!.time);
    expect(last).toHaveLength(3);
    expect(last[0]!.values[0]!.value).toBeCloseTo((bars.at(-1)!.close + bars.at(-2)!.close)/2, 10);
    expect(last[0]!.label).not.toBe(last[1]!.label);
    const crosshair = m.chart.subscribeCrosshairMove.mock.calls[0]![0];
    crosshair({point:{x:50,y:350},paneIndex:1,time:bars[40]!.time});
    expect((adapter as any).hoveredCandle?.time).toBe(bars[40]!.time);
    adapter.setStudies([]);
    expect(adapter.getStudyValues(bars[40]!.time)).toEqual([]);
  });
  it.each(STUDY_CATALOG)("$name retains only correct causal state across replay and corrections", definition => {
    const config = definition.defaults;
    adapter.setStudies([config]);
    const renderedStudies=m.handles.slice(1);
    const verify = (next: typeof bars) => {
      Object.assign(m.scale.getVisibleLogicalRange(),{from:Math.max(0,next.length-20),to:next.length+10});
      adapter.setCandles(next);
      const expected = new StudyCalculator(config).calculate(next);
      for (const [i,candle] of next.entries()) {
        expect(adapter.getStudyValues(candle.time)[0]!.values.map(v=>v.value)).toEqual(expected[i]!.values);
      }
      for(const [channel,line] of renderedStudies.entries()){
        expect(line.data).toEqual(expected.map(point=>{
          const value=point.values[channel];return value==null||!Number.isFinite(value)?{time:point.time}:{time:point.time,value,
            ...(config.kind==='macd'&&channel===2?{color:value>=0?'#10b981':'#ef4444'}:{})};
        }));
      }
      const future = bars.find(c=>!next.some(n=>n.time===c.time));
      if(future)expect(adapter.getStudyValues(future.time)[0]!.values.every(v=>v.value==null)).toBe(true);
    };
    verify(bars.slice(0,99)); verify(bars); verify(bars.slice(0,1)); verify(bars);
    verify([]); verify(bars.slice(0,1)); verify(bars.slice(10)); verify(bars);
    const revised = bars.map((b,i)=>i===30?{...b,close:1.9}:b);
    verify(revised); verify(revised.slice(0,50)); verify(bars);
    adapter.setChartStyle("line"); verify(bars.slice(0,99));
    // Display transforms never reach the studies: they stay on canonical OHLC.
    adapter.setChartStyle("heikinAshi"); verify(revised); verify(bars.slice(0,70));
    adapter.setChartStyle("area"); verify(bars.slice(5));
    adapter.setChartStyle("hollow"); verify(bars);
    adapter.setChartStyle("bars"); verify(bars);
    adapter.updateActiveCandle({...bars.at(-1)!,close:1.85});
    // A queued streaming revision must not be lost when an immediate poll adds
    // a new candle before the scheduled study frame runs.
    verify([...bars.slice(0,-1),{...bars.at(-1)!,close:1.85},{...bars.at(-1)!,time:6100,close:1.7}]);
  });
  it("keeps user drawings separate and excludes off-history endpoints from the time scale",()=>{
    adapter.setDrawings([{id:"h",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"},{id:"t",kind:"trend",start:{time:100,price:1.2},end:{time:160,price:1.4},color:"#ffffff"},{id:"outside",kind:"trend",start:{time:1,price:1.2},end:{time:160,price:1.4},color:"#ffffff"}]);
    expect(m.handles).toHaveLength(1);
    expect(m.handles[0].attachPrimitive).toHaveBeenCalledTimes(1);
    const primitive = m.handles[0].attachPrimitive.mock.calls[0][0];
    expect(primitive.autoscaleInfo).toBeUndefined();
    adapter.setStructureLines([{id:"ai",start:{time:100,price:1.3},end:{time:160,price:1.4},color:"#ffffff",dashed:false,width:1}],[]);
    const structure=m.handles.at(-1);adapter.setDrawings([]);
    expect(m.chart.removeSeries).not.toHaveBeenCalledWith(structure);
    expect(primitive.drawings).toEqual([]);
    expect(m.chart.removeSeries).not.toHaveBeenCalledWith(m.handles[0]);
  });
  it("accepts drawing clicks only over real candles in the price pane",()=>{
    const handler=vi.fn();adapter.setDrawingHandler(handler);
    const canvas=document.createElement("canvas");container.append(canvas);
    const click=(x:number,y:number,dx=0)=>{canvas.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,clientX:x,clientY:y}));canvas.dispatchEvent(new MouseEvent("pointerup",{bubbles:true,clientX:x+dx,clientY:y}));};
    click(100,350);click(900,50);click(100,50,20);
    expect(handler).not.toHaveBeenCalled();
    click(100,50);click(200,50);expect(handler).toHaveBeenCalledTimes(2);expect(handler).toHaveBeenCalledWith({time:100,price:1.2});
    m.scale.coordinateToTime.mockReturnValueOnce(99);click(100,50);expect(handler).toHaveBeenCalledTimes(2);
    adapter.destroy();click(100,50);expect(handler).toHaveBeenCalledTimes(2);
  });
});

// Varied OHLC on real-epoch timestamps (the shared `bars` have
// constant open/high/low, which would hide Heikin Ashi and hollow mistakes).
function variedBars(n=100,startTime=1_700_000_000,seed=17):ChartEngineCandle[] {
  let x=seed,close=1.1;
  const rand=()=>{x=(x*1103515245+12345)%2147483648;return x/2147483648;};
  return Array.from({length:n},(_,i)=>{
    const open=close+(rand()-.5)*.002;close=open+(rand()-.5)*.006;
    return {time:startTime+i*60,open,high:Math.max(open,close)+rand()*.002,low:Math.min(open,close)-rand()*.002,close};
  });
}
const varied=variedBars();
const expectedPoints=(style:ChartStyle,candles:ChartEngineCandle[])=>style==="heikinAshi" ? heikinAshi(candles)
  : style==="hollow" ? candles.map((c,i)=>hollowPoint(c,i?candles[i-1]!.close:null))
  : ["line","area","baseline"].includes(style) ? candles.map(c=>({time:c.time,value:c.close})) : candles.map(c=>({...c}));
const priceHandle=()=>m.handles.at(-1);
const baseValueCalls=(handle:any)=>handle.applyOptions.mock.calls.filter((call:any[])=>"baseValue" in call[0]).map((call:any[])=>call[0].baseValue.price);
describe("area, baseline, Heikin Ashi and hollow display styles",()=>{
  let frames:FrameRequestCallback[]=[];
  const flush=()=>{for(let i=0;i<5&&frames.length;i++){const due=frames.splice(0);for(const frame of due)frame(0);}};
  beforeEach(()=>{
    frames=[];
    vi.stubGlobal("requestAnimationFrame",(frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;});
    vi.stubGlobal("cancelAnimationFrame",()=>{});
    adapter.setCandles(varied);
  });
  afterEach(()=>{flush();vi.unstubAllGlobals();vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});});

  it.each(["area","baseline","heikinAshi","hollow"] as const)("%s keeps range, studies, drawings, annotation and overlay lines on a style switch",style=>{
    adapter.setStudies(STUDY_DEFAULTS);const studies=m.handles.slice(1);
    adapter.setDrawings([{id:"saved",kind:"horizontal",start:{time:varied[3]!.time,price:1.1},color:"#ffffff"}]);
    const original=m.handles[0],drawing=original.attachPrimitive.mock.calls[0][0];
    adapter.setSmartAnnotation({id:"doji",anchors:[{time:varied[4]!.time,price:1.1,label:"Doji"}],color:"#38bdf8",dashed:true});
    const automatic=original.attachPrimitive.mock.calls.at(-1)[0];
    adapter.setOverlays([{id:"entry",type:"line",symbol:"EURUSD",price:1.105,label:"Entry",source:"position"}],varied.at(-1)!.time);
    adapter.setChartStyle(style);
    const price=priceHandle();
    expect(price.kind).toBe({area:"area",baseline:"baseline",heikinAshi:"candles",hollow:"candles"}[style]);
    expect(m.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:10,to:30});
    expect(price.attachPrimitive).toHaveBeenCalledWith(drawing);
    expect(price.attachPrimitive).toHaveBeenCalledWith(automatic);
    expect(original.detachPrimitive).toHaveBeenCalledWith(automatic);
    expect(m.chart.removeSeries).toHaveBeenCalledWith(original);
    for(const study of studies)expect(m.chart.removeSeries).not.toHaveBeenCalledWith(study);
    expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:1.105,title:"Entry"}));
    expect(price.data).toEqual(expectedPoints(style,varied));
    if(style==="hollow")expect(price.options.borderVisible).toBe(true);
    // Studies, visible candles and the canonical history are untouched.
    expect(adapter.getVisibleCandles()).toEqual(varied.slice(10,31));
    expect(adapter.getStudyValues(varied.at(-1)!.time)[0]!.values[0]!.value).toBeCloseTo(new StudyCalculator(STUDY_DEFAULTS[0]!).calculate(varied).at(-1)!.values[0]!,12);
  });

  it("refreshes the legend after a style switch without pointer movement and exposes HA only in Heikin Ashi",()=>{
    const handler=vi.fn();adapter.setCrosshairHandler(handler);
    adapter.setChartStyle("line");flush();handler.mockClear();
    adapter.setChartStyle("heikinAshi");
    expect(handler).not.toHaveBeenCalled();flush();
    expect(handler).toHaveBeenCalledTimes(1);
    // The handler still receives the canonical candle.
    expect(handler).toHaveBeenLastCalledWith(varied.at(-1));
    const ha=heikinAshi(varied);
    for(const i of [0,1,50,99])expect(adapter.getDisplayCandle(varied[i]!.time)).toEqual(ha[i]);
    expect(adapter.getDisplayCandle(varied[0]!.time+1)).toBeNull();
    // Hovering keeps canonical OHLC in the handler; the display bar is separate.
    const crosshair=m.chart.subscribeCrosshairMove.mock.calls[0]![0];
    crosshair({point:{x:50,y:50},time:varied[40]!.time});flush();
    expect(handler).toHaveBeenLastCalledWith(varied[40]);
    expect(adapter.getDisplayCandle(varied[40]!.time)).toEqual(ha[40]);
    adapter.setChartStyle("candles");flush();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenLastCalledWith(varied[40]);
    expect(adapter.getDisplayCandle(varied[40]!.time)).toBeNull();
    for(const style of ["area","baseline","hollow","bars","line"] as const){adapter.setChartStyle(style);flush();expect(adapter.getDisplayCandle(varied[40]!.time)).toBeNull();}
    expect(handler).toHaveBeenCalledTimes(8);
  });

  it("pins the baseline base to the first loaded close and moves it only when that bar changes",()=>{
    adapter.setChartStyle("baseline");const price=priceHandle();
    expect(price.options.baseValue).toEqual({type:"price",price:varied[0]!.close});
    const next={...varied.at(-1)!,time:varied.at(-1)!.time+60};
    adapter.setCandles([...varied,next]);
    expect(baseValueCalls(price)).toEqual([]);
    adapter.updateActiveCandle({...next,close:next.close+0.001,high:next.high+0.001});
    expect(baseValueCalls(price)).toEqual([]);
    // The fixed-size live window rolls forward: one bar off the left, one appended.
    const rolled=[...varied.slice(1),next,{...next,time:next.time+60}];
    adapter.setCandles(rolled);
    expect(baseValueCalls(price)).toEqual([varied[1]!.close]);
    expect(price.data).toEqual(expectedPoints("baseline",rolled));
    adapter.setCandles(rolled);expect(baseValueCalls(price)).toEqual([varied[1]!.close]);
    // A deep-history prepend moves the base to the new first bar.
    const older=variedBars(20,varied[0]!.time-20*60,3);
    adapter.setCandles([...older,...rolled]);
    expect(baseValueCalls(price)).toEqual([varied[1]!.close,older[0]!.close]);
    // A context reset then new candles pins the new context's first close.
    adapter.resetDataContext();
    const other=variedBars(30,50_000,5).map(c=>({...c,open:c.open*50,high:c.high*50,low:c.low*50,close:c.close*50}));
    adapter.setCandles(other);
    expect(baseValueCalls(price).at(-1)).toBe(other[0]!.close);
    expect(price.data).toEqual(expectedPoints("baseline",other));
  });

  it("keeps Heikin Ashi data equal to a full recompute through corrections, appends, tips, prepends and roll-off",()=>{
    adapter.setChartStyle("heikinAshi");const price=priceHandle();
    const check=(candles:ChartEngineCandle[])=>{expect(price.data).toEqual(heikinAshi(candles));expect((adapter as any).haBars).toEqual(heikinAshi(candles));};
    check(varied);
    // Mid-history correction: full write of the revised history.
    const revised=varied.map((c,i)=>i===30?{...c,close:c.close+0.003,high:Math.max(c.high,c.close+0.003)}:c);
    let writes=price.setData.mock.calls.length;
    adapter.setCandles(revised);
    expect(price.setData).toHaveBeenCalledTimes(writes+1);check(revised);
    // One appended closed bar goes through update(), not setData.
    const appended=[...revised,{...variedBars(1,revised.at(-1)!.time+60,9)[0]!}];
    writes=price.setData.mock.calls.length;let updates=price.update.mock.calls.length;
    adapter.setCandles(appended);
    expect(price.setData).toHaveBeenCalledTimes(writes);expect(price.update).toHaveBeenCalledTimes(updates+1);check(appended);
    // Same-time and new-time live tips (O(1) update each).
    const last=appended.at(-1)!;
    const sameTime={...last,close:last.close+0.002,high:Math.max(last.high,last.close+0.002)};
    updates=price.update.mock.calls.length;
    adapter.updateActiveCandle(sameTime);
    expect(price.update).toHaveBeenCalledTimes(updates+1);check([...appended.slice(0,-1),sameTime]);
    const tip={time:last.time+60,open:sameTime.close,high:sameTime.close+0.003,low:sameTime.close-0.001,close:sameTime.close+0.001};
    adapter.updateActiveCandle(tip);
    const withTip=[...appended.slice(0,-1),sameTime,tip];check(withTip);
    // An out-of-order (older) tip is ignored.
    updates=price.update.mock.calls.length;
    adapter.updateActiveCandle({...appended[10]!});
    expect(price.update).toHaveBeenCalledTimes(updates);check(withTip);
    // A lagging closed-window poll keeps the newer streamed tip.
    const closed=[...appended.slice(0,-1),sameTime];
    adapter.setCandles(closed);check(withTip);
    // Deep-history prepend: full write and the viewed range shifts by the prepended count.
    const older=variedBars(25,varied[0]!.time-25*60,4);
    const deep=[...older,...withTip];
    writes=price.setData.mock.calls.length;
    adapter.setCandles(deep);
    expect(price.setData).toHaveBeenCalledTimes(writes+1);check(deep);
    expect(m.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:35,to:55});
    // The fixed-size window rolls forward: the leftmost bodies re-seed.
    const window=[...deep.slice(3),{...tip,time:tip.time+60}];
    adapter.setCandles(window);check(window);
    expect(heikinAshi(window)[0]!.open).not.toBe(heikinAshi(deep)[3]!.open);
  });

  it("follows replay seeks in Heikin Ashi: short backward seeks pop, long seeks rewrite",()=>{
    adapter.setChartStyle("heikinAshi");const price=priceHandle();
    const seek=(count:number)=>adapter.setCandles(varied.slice(0,count),{revealLatest:true});
    const check=(count:number)=>{expect(price.data).toEqual(heikinAshi(varied.slice(0,count)));expect((adapter as any).haBars).toEqual(heikinAshi(varied.slice(0,count)));};
    seek(60);check(60);
    let writes=price.setData.mock.calls.length;
    seek(55);
    expect(price.pop).toHaveBeenLastCalledWith(5);expect(price.setData).toHaveBeenCalledTimes(writes);check(55);
    seek(5);
    expect(price.setData).toHaveBeenCalledTimes(writes+1);check(5);
    writes=price.setData.mock.calls.length;const updates=price.update.mock.calls.length;
    seek(30);
    expect(price.setData).toHaveBeenCalledTimes(writes);expect(price.update).toHaveBeenCalledTimes(updates+25);check(30);
    seek(90);
    expect(price.setData).toHaveBeenCalledTimes(writes+1);check(90);
    expect(m.scale.scrollToPosition).toHaveBeenCalled();
  });

  it("keeps the Last line canonical and hides the Heikin Ashi series' own last-value label",()=>{
    adapter.setChartStyle("heikinAshi");const price=priceHandle();
    adapter.setFeedState({livePriceAffordance:true,source:"fixture"});
    expect(price.applyOptions).toHaveBeenLastCalledWith({priceLineVisible:false,lastValueVisible:false});
    expect(price.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({price:varied.at(-1)!.close,title:"Last"}));
    const line=price.createPriceLine.mock.results.at(-1)!.value;
    const tip={...varied.at(-1)!,close:varied.at(-1)!.close+0.001,high:varied.at(-1)!.high+0.001};
    adapter.updateActiveCandle(tip);
    expect(line.applyOptions).toHaveBeenLastCalledWith({price:tip.close});
    expect(heikinAshi([...varied.slice(0,-1),tip]).at(-1)!.close).not.toBe(tip.close);
    // Every other style keeps the series label when the feed is live.
    adapter.setChartStyle("hollow");
    expect(priceHandle().applyOptions).toHaveBeenCalledWith({priceLineVisible:true,lastValueVisible:true});
  });

  it("colours a hollow live tip from the previous canonical close in O(1)",()=>{
    adapter.setChartStyle("hollow");const price=priceHandle();
    const prev=varied.at(-1)!;
    const tip={time:prev.time+60,open:prev.close,high:prev.close+0.002,low:prev.close-0.002,close:prev.close-0.001};
    adapter.updateActiveCandle(tip);
    expect(price.data.at(-1)).toEqual(hollowPoint(tip,prev.close));
    expect(price.data).toEqual(expectedPoints("hollow",[...varied,tip]));
  });
});
