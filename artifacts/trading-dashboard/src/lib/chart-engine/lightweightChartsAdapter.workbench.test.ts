import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>{
  const handles:any[]=[];
  const range={from:10,to:30};
  const scale={subscribeVisibleLogicalRangeChange:vi.fn(),getVisibleLogicalRange:()=>range,setVisibleLogicalRange:vi.fn(),setVisibleRange:vi.fn(),fitContent:vi.fn(),width:()=>800,coordinateToTime:vi.fn(()=>100)};
  const chart={addSeries:vi.fn((kind:any,options:any,pane=0)=>{const handle={kind,options,pane,setData:vi.fn(),update:vi.fn(),applyOptions:vi.fn(),createPriceLine:vi.fn(()=>({applyOptions:vi.fn()})),removePriceLine:vi.fn(),coordinateToPrice:()=>1.2};handles.push(handle);return handle;}),removeSeries:vi.fn(),subscribeClick:vi.fn(),subscribeCrosshairMove:vi.fn(),timeScale:()=>scale,applyOptions:vi.fn(),remove:vi.fn(),panes:()=>Array.from({length:4},()=>({setHeight:vi.fn(),setStretchFactor:vi.fn(),getHeight:()=>300}))};
  return{chart,handles,scale};
});
vi.mock("lightweight-charts",()=>({createChart:()=>m.chart,CandlestickSeries:"candles",BarSeries:"bars",LineSeries:"line",HistogramSeries:"histogram",createSeriesMarkers:()=>({detach:vi.fn()}),ColorType:{Solid:"solid"},CrosshairMode:{Normal:0},LineStyle:{Dashed:2,Solid:0},PriceScaleMode:{Normal:0,Logarithmic:1}}));
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
import { STUDY_DEFAULTS } from "./chartStudies";
const bars=Array.from({length:100},(_,i)=>({time:100+i*60,open:1,high:2,low:1,close:1.5+Math.sin(i)*.1}));
let adapter:LightweightChartsAdapter;
let container:HTMLDivElement;
beforeEach(()=>{vi.clearAllMocks();m.handles.length=0;vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});adapter=new LightweightChartsAdapter();container=document.createElement("div");adapter.init({container,height:500});adapter.setCandles(bars);});
describe("Smart Chart studies, styles and drawing ownership",()=>{
  it("keeps studies incremental and independent of style switches and live-price truth",()=>{
    adapter.setStudies(STUDY_DEFAULTS);const studies=m.handles.slice(1);
    expect(studies).toHaveLength(9);expect(studies.filter(s=>s.pane===1)).toHaveLength(1);expect(studies.filter(s=>s.pane===2)).toHaveLength(3);
    adapter.updateActiveCandle({...bars.at(-1)!,close:1.7});
    for(const study of studies){expect(study.setData).toHaveBeenCalledTimes(1);expect(study.update).toHaveBeenCalledTimes(1);}
    adapter.setChartStyle("line");const price=m.handles.at(-1);
    expect(price.setData.mock.calls[0][0].at(-1)).toEqual({time:bars.at(-1)!.time,value:1.7});
    expect(price.applyOptions).toHaveBeenCalledWith({priceLineVisible:false,lastValueVisible:false});
    expect(m.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({from:10,to:30});
    adapter.setStudies([]);expect(m.chart.removeSeries).not.toHaveBeenCalledWith(price);
    for(const study of studies)expect(m.chart.removeSeries).toHaveBeenCalledWith(study);
  });
  it("keeps user drawings separate and excludes off-history endpoints from the time scale",()=>{
    adapter.setDrawings([{id:"h",kind:"horizontal",start:{time:100,price:1.2},color:"#ffffff"},{id:"t",kind:"trend",start:{time:100,price:1.2},end:{time:160,price:1.4},color:"#ffffff"},{id:"outside",kind:"trend",start:{time:1,price:1.2},end:{time:160,price:1.4},color:"#ffffff"}]);
    expect(m.handles).toHaveLength(2);
    expect(m.handles[1].options.autoscaleInfoProvider()).toBeNull();
    adapter.setStructureLines([{id:"ai",start:{time:100,price:1.3},end:{time:160,price:1.4},color:"#ffffff",dashed:false,width:1}],[]);
    const structure=m.handles.at(-1);adapter.setDrawings([]);
    expect(m.chart.removeSeries).toHaveBeenCalledWith(m.handles[1]);expect(m.chart.removeSeries).not.toHaveBeenCalledWith(structure);
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
