import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>{
  const handles:any[]=[];
  const range={from:10,to:30};
  const scale={subscribeVisibleLogicalRangeChange:vi.fn(),getVisibleLogicalRange:()=>range,setVisibleLogicalRange:vi.fn(),setVisibleRange:vi.fn(),fitContent:vi.fn(),options:()=>({rightOffset:10}),scrollToPosition:vi.fn(),width:()=>800,coordinateToTime:vi.fn(()=>100)};
  const chart={addSeries:vi.fn((kind:any,options:any,pane=0)=>{const data:any[]=[];const handle={kind,options,pane,data,
    setData:vi.fn((next:any[])=>data.splice(0,data.length,...next.map(point=>({...point})))),
    update:vi.fn((point:any)=>{const last=data.at(-1);if(last&&point.time<last.time)throw new Error('Historical update');if(last?.time===point.time)data[data.length-1]={...point};else data.push({...point});}),
    pop:vi.fn((count:number)=>{for(let i=data.length-1;i>=0&&count>0;i--)if(data[i].value!=null||data[i].close!=null){data.splice(i,1);count--;}}),applyOptions:vi.fn(),createPriceLine:vi.fn(()=>({applyOptions:vi.fn()})),removePriceLine:vi.fn(),coordinateToPrice:()=>1.2,attachPrimitive:vi.fn(),detachPrimitive:vi.fn()};handles.push(handle);return handle;}),removeSeries:vi.fn(),subscribeClick:vi.fn(),subscribeCrosshairMove:vi.fn(),timeScale:()=>scale,applyOptions:vi.fn(),remove:vi.fn(),clearCrosshairPosition:vi.fn(),panes:()=>Array.from({length:4},()=>({setHeight:vi.fn(),setStretchFactor:vi.fn(),getHeight:()=>300}))};
  return{chart,handles,scale};
});
vi.mock("lightweight-charts",()=>({createChart:()=>m.chart,CandlestickSeries:"candles",BarSeries:"bars",LineSeries:"line",HistogramSeries:"histogram",createSeriesMarkers:()=>({detach:vi.fn()}),ColorType:{Solid:"solid"},CrosshairMode:{Normal:0},LineStyle:{Dashed:2,Solid:0},PriceScaleMode:{Normal:0,Logarithmic:1}}));
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import { STUDY_DEFAULTS, STUDY_CATALOG, StudyCalculator } from "./chartStudies";
const bars=Array.from({length:100},(_,i)=>({time:100+i*60,open:1,high:2,low:1,close:1.5+Math.sin(i)*.1}));
let adapter:LightweightChartsAdapter;
let container:HTMLDivElement;
beforeEach(()=>{Object.assign(m.scale.getVisibleLogicalRange(),{from:10,to:30});vi.clearAllMocks();m.handles.length=0;vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});adapter=new LightweightChartsAdapter();container=document.createElement("div");document.body.append(container);adapter.init({container,height:500});adapter.setCandles(bars);});
afterEach(()=>{adapter.destroy();container.remove();});
describe("Smart Chart studies, styles and drawing ownership",()=>{
  it("discards Replay checkpoints at native no-op, source, streaming and reset boundaries",()=>{
    adapter.setStudies([STUDY_DEFAULTS[0]!]);
    const calc=(adapter as any).analysis.studies[0].calculator;
    const replay={sessionId:"one",ownerId:7,source:"deriv_public",sourceIdentity:"a".repeat(64),symbol:"V75",timeframe:"M15"};
    const earn=()=>{adapter.setCandles(bars,{revealLatest:true,replay});expect(calc.replayCache.inputs).toHaveLength(100);};
    earn();adapter.setCandles(bars);expect(calc.replayCache).toBeNull();
    earn();adapter.setFeedState({livePriceAffordance:false,source:"other"});expect(calc.replayCache).toBeNull();
    earn();adapter.updateActiveCandle({...bars.at(-1)!,close:1.85});expect(calc.replayCache).toBeNull();
    earn();adapter.resetDataContext();expect(calc.replayCache).toBeNull();expect(calc.points).toEqual([]);
    earn();adapter.destroy();expect(calc.replayCache).toBeNull();
  });
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
