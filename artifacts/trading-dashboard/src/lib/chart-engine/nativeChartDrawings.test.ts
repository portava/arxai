import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeChartViewport } from "./nativeChartViewport";
import type { ChartAnchor, ChartDrawing } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";

const bars = (start=0,count=200):ChartEngineCandle[] => Array.from({length:count},(_,i)=>({time:1700000000+(start+i)*60,open:100+start+i,high:104+start+i,low:98+start+i,close:102+start+i}));
const trend = ():ChartDrawing => ({id:"line",kind:"trend",color:"#123abc",start:{time:bars()[140]!.time,price:242},end:{time:bars()[160]!.time,price:262}});
let container:HTMLDivElement,canvas:HTMLCanvasElement,viewport:NativeChartViewport;
let queue:Map<number,FrameRequestCallback>,nextId:number;
let ops:Array<{name:string;args:any[];color:unknown}>;
function flush(){const calls=[...queue.values()];queue.clear();calls.forEach(fn=>fn(0));}
function pointer(type:string,x:number,y:number,id=1){const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x+10,clientY:y+20,button:0});Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:"mouse"},isPrimary:{value:true}});canvas.dispatchEvent(event);return event;}
function key(key:string,options:KeyboardEventInit={}){const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...options});canvas.dispatchEvent(event);return event;}
function position(anchor:ChartAnchor){const frame=viewport.getFrame()!;return {x:frame.timeToX(anchor.time)!,y:frame.priceToY(anchor.price)!};}
function interactions(selectedId:string|null="line",snap=false){const onCommit=vi.fn(),onSelect=vi.fn(),onUndo=vi.fn(),onRedo=vi.fn();viewport.setDrawingInteraction({selectedId,snap,onCommit,onSelect,onUndo,onRedo});return {onCommit,onSelect,onUndo,onRedo};}
function startDrag(d=trend()){viewport.setDrawings([d]);const callbacks=interactions(d.id),point=position(d.start);pointer("pointerdown",point.x,point.y);return {...callbacks,point};}
beforeEach(()=>{
  queue=new Map();nextId=1;ops=[];
  const target:any={measureText:(text:string)=>({width:text.length*6})};
  const ctx=new Proxy(target,{get:(obj,name)=>{if(!(name in obj))obj[name]=vi.fn((...args:any[])=>{ops.push({name:String(name),args,color:obj.strokeStyle});});return obj[name];},set:(obj,name,value)=>{obj[name]=value;return true;}});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(ctx);
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){const width=this instanceof HTMLCanvasElement?parseFloat(this.style.width):800,height=this instanceof HTMLCanvasElement?parseFloat(this.style.height):400;return {left:10,top:20,width,height,x:10,y:20,right:10+width,bottom:20+height,toJSON(){}};});
  vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>{const id=nextId++;queue.set(id,fn);return id;});vi.stubGlobal("cancelAnimationFrame",(id:number)=>queue.delete(id));
  vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});vi.stubGlobal("matchMedia",()=>({addEventListener(){},removeEventListener(){}}));vi.stubGlobal("devicePixelRatio",2);
  container=document.createElement("div");document.body.append(container);viewport=new NativeChartViewport(container);canvas=container.querySelector("canvas")!;canvas.setPointerCapture=vi.fn();canvas.releasePointerCapture=vi.fn();viewport.setCandles(bars());viewport.setRange({from:120,to:180});flush();
});
afterEach(()=>{viewport?.destroy();container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe("native drawing viewport integration",()=>{
  it("paints exact source-price anchors in translated CSS plot coordinates",()=>{
    const d=trend(),frame=viewport.getFrame()!;viewport.setDrawings([d]);ops=[];flush();
    const drawingOps=ops.filter(op=>op.color===d.color);
    expect(drawingOps.some(op=>op.name==="moveTo"&&Math.abs(op.args[0]-(frame.timeToX(d.start.time)!-frame.plot.left))<1e-8&&Math.abs(op.args[1]-(frame.priceToY(d.start.price)!-frame.plot.top))<1e-8)).toBe(true);
    expect(drawingOps.some(op=>op.name==="lineTo"&&Math.abs(op.args[0]-(frame.timeToX(d.end!.time)!-frame.plot.left))<1e-8)).toBe(true);
    expect(ops.some(op=>op.name==="translate"&&op.args[0]===frame.plot.left&&op.args[1]===frame.plot.top)).toBe(true);
  });
  it("owns cloned drawings and does not expose mutable retained anchors",()=>{
    const d=trend();viewport.setDrawings([d]);d.start.price=999;const first=viewport.getDrawings();expect(first[0]!.start.price).toBe(242);first[0]!.start.price=777;expect(viewport.getDrawings()[0]!.start.price).toBe(242);
  });
  it.each([false,true])("placement snaps to canonical OHLC under HA logarithmic inverted=%s",inverted=>{
    viewport.setStyle("heikinAshi");viewport.setScale("log",inverted);interactions(null,true);const placed=vi.fn();viewport.setDrawingHandler(placed);
    const bar=bars()[150]!,frame=viewport.getFrame()!,x=frame.timeToX(bar.time)!,y=frame.priceToY(bar.high)!;
    pointer("pointerdown",x,y);pointer("pointerup",x,y);
    expect(placed).toHaveBeenCalledOnce();expect(placed.mock.calls[0]![0]).toEqual({time:bar.time,price:bar.high});expect(frame.series.heikinAshi[150]!.close).not.toBe(bar.high);
  });
  it("drawing placement excludes auxiliary pane coordinates and permits only real price bars",()=>{
    viewport.setStudies([{kind:"rsi",period:14,color:"#ffffff"}]);interactions(null);const placed=vi.fn();viewport.setDrawingHandler(placed);const pane=viewport.getPaneLayout()!.panes[0]!;
    pointer("pointerdown",200,pane.top+20);pointer("pointerup",200,pane.top+20);expect(placed).not.toHaveBeenCalled();
    const frame=viewport.getFrame()!,x=frame.timeToX(bars()[150]!.time)!,y=frame.priceToY(252)!;pointer("pointerdown",x,y);pointer("pointerup",x,y);expect(placed).toHaveBeenCalledOnce();
  });
  it("a completed handle drag commits once and never pans the chart",()=>{
    const before=viewport.getRange(),frame=viewport.getFrame()!,{point,onCommit}=startDrag();expect(viewport.getState().editingDrawing).toBe(true);
    const x=point.x+frame.spacing*2,y=point.y+14;pointer("pointermove",x,y);expect(onCommit).not.toHaveBeenCalled();pointer("pointerup",x,y);
    expect(onCommit).toHaveBeenCalledOnce();expect(viewport.getRange()).toEqual(before);expect(viewport.getDrawings()[0]!.start.time).toBe(bars()[142]!.time);expect(viewport.getDrawings()[0]!.start.price).toBeCloseTo(frame.yToPrice(y)!,9);expect(viewport.getState().editingDrawing).toBe(false);
  });
  it.each(["Escape","pointercancel","lostpointercapture","blur"])("%s cancels a preview without committing it",how=>{
    const d=trend(),{point,onCommit}=startDrag(d);pointer("pointermove",point.x+25,point.y+15);expect(viewport.getDrawings()).not.toEqual([d]);
    if(how==="Escape")key("Escape");else if(how==="blur")window.dispatchEvent(new Event("blur"));else pointer(how,point.x+25,point.y+15);
    expect(viewport.getDrawings()).toEqual([d]);expect(onCommit).not.toHaveBeenCalled();expect(viewport.getState().editingDrawing).toBe(false);
  });
  it("local undo/redo and delete are owned by the focused chart",()=>{
    const d=trend();viewport.setDrawings([d]);const {onCommit,onUndo,onRedo}=interactions();canvas.focus();key("z",{ctrlKey:true});key("z",{ctrlKey:true,shiftKey:true});expect(onUndo).toHaveBeenCalledOnce();expect(onRedo).toHaveBeenCalledOnce();key("Delete");expect(onCommit).toHaveBeenLastCalledWith([]);expect(viewport.getDrawings()).toEqual([]);
  });
  it("locked or hidden drawings cannot be deleted or moved",()=>{
    for(const flags of [{locked:true},{hidden:true}]){const d={...trend(),...flags};viewport.setDrawings([d]);const {onCommit}=interactions();canvas.focus();key("Delete");const p=position(d.start);pointer("pointerdown",p.x,p.y);pointer("pointermove",p.x+20,p.y+10);pointer("pointerup",p.x+20,p.y+10);expect(onCommit).not.toHaveBeenCalled();expect(viewport.getDrawings()).toEqual([d]);}
  });
  it("pan mode disables drawing capture and placement while retaining saved geometry",()=>{
    const d=trend();viewport.setDrawings([d]);const {onCommit}=interactions();const placed=vi.fn();viewport.setDrawingHandler(placed);viewport.setNavigationMode("pan");const p=position(d.start),before=viewport.getRange()!;pointer("pointerdown",p.x,p.y);pointer("pointermove",p.x+20,p.y);pointer("pointerup",p.x+20,p.y);expect(viewport.getRange()!.from).toBeLessThan(before.from);expect(onCommit).not.toHaveBeenCalled();expect(placed).not.toHaveBeenCalled();expect(viewport.getDrawings()).toEqual([d]);
  });
  it.each(["refresh","append","prepend"])("%s during editing preserves the original pixel-to-price mapping",kind=>{
    const d=trend(),frame=viewport.getFrame()!,{point,onCommit}=startDrag(d);pointer("pointermove",point.x+frame.spacing,point.y+10);
    const next=kind==="prepend"?bars(-20,220):kind==="append"?bars(0,201):bars();const changed=next.find(bar=>bar.time===bars()[150]!.time)!;changed.high=100000;viewport.setCandles(next);
    expect(viewport.getState().editingDrawing).toBe(true);expect(viewport.getFrame()!.timeToX(d.start.time)).toBeCloseTo(point.x,9);expect(viewport.getFrame()!.priceToY(250)).toBeCloseTo(frame.priceToY(250)!,9);
    const y=point.y+20,x=point.x+frame.spacing*2;pointer("pointermove",x,y);pointer("pointerup",x,y);expect(onCommit).toHaveBeenCalledOnce();expect(viewport.getDrawings()[0]!.start.price).toBeCloseTo(frame.yToPrice(y)!,9);expect(viewport.getDrawings()[0]!.start.time).toBe(bars()[142]!.time);
  });
  it.each(["trim","disjoint"])("%s removing original anchors cancels edit without committing preview",kind=>{
    const d=trend(),{point,onCommit}=startDrag(d);pointer("pointermove",point.x+20,point.y+10);viewport.setCandles(kind==="trim"?bars(145,100):bars(500,200));
    expect(viewport.getState().editingDrawing).toBe(false);expect(onCommit).not.toHaveBeenCalled();expect(viewport.getDrawings()).toEqual([d]);pointer("pointerup",point.x+40,point.y+20);expect(onCommit).not.toHaveBeenCalled();
  });
  it("context reset clears drawings and pending callbacks without restoring old-market edits",()=>{
    const {point,onCommit}=startDrag();pointer("pointermove",point.x+20,point.y+10);viewport.resetContext();viewport.setCandles(bars(500));pointer("pointerup",point.x+20,point.y+10);expect(viewport.getDrawings()).toEqual([]);expect(onCommit).not.toHaveBeenCalled();expect(viewport.getState().editingDrawing).toBe(false);
  });
  it("destroy stops drawing listeners, callbacks and queued paints",()=>{
    const {point,onCommit}=startDrag();pointer("pointermove",point.x+20,point.y+10);viewport.destroy();pointer("pointerup",point.x+20,point.y+10);key("Delete");flush();expect(onCommit).not.toHaveBeenCalled();expect(viewport.getDrawings()).toEqual([]);expect(queue.size).toBe(0);
  });
  it("trim cancels a drawing edit if clamped rebasing changes horizontal coordinates",()=>{
    viewport.setRange({from:-1,to:199});const d={...trend(),start:{time:bars()[150]!.time,price:252},end:{time:bars()[170]!.time,price:272}};
    const {point,onCommit}=startDrag(d);pointer("pointermove",point.x+10,point.y+10);viewport.setCandles(bars(10,190));
    expect(viewport.getState().editingDrawing).toBe(false);expect(viewport.getDrawings()).toEqual([d]);pointer("pointerup",point.x+30,point.y+20);expect(onCommit).not.toHaveBeenCalled();
  });
  it("trim removing an original anchor cancels even when its preview anchor remains loaded",()=>{
    const d=trend(),frame=viewport.getFrame()!,{point,onCommit}=startDrag(d);pointer("pointermove",point.x+frame.spacing*10,point.y+10);
    expect(viewport.getDrawings()[0]!.start.time).toBe(bars()[150]!.time);viewport.setCandles(bars(145,100));
    expect(viewport.getState().editingDrawing).toBe(false);expect(viewport.getDrawings()).toEqual([d]);pointer("pointerup",point.x+frame.spacing*12,point.y+20);expect(onCommit).not.toHaveBeenCalled();
  });
  it.each(["reset","destroy"])("onSelect %s cannot restart a captured old drawing gesture",action=>{
    const d=trend(),onCommit=vi.fn();viewport.setDrawings([d]);viewport.setDrawingInteraction({selectedId:"line",snap:false,onSelect:()=>action==="reset"?viewport.resetContext():viewport.destroy(),onCommit});const p=position(d.start);
    pointer("pointerdown",p.x,p.y);pointer("pointermove",p.x+30,p.y+20);pointer("pointerup",p.x+30,p.y+20);
    expect(onCommit).not.toHaveBeenCalled();expect(viewport.getDrawings()).toEqual([]);expect(viewport.getState().editingDrawing).toBe(false);
  });
  it("mutating commit callback drawings cannot alter viewport-owned anchors",()=>{
    const d=trend();viewport.setDrawings([d]);viewport.setDrawingInteraction({selectedId:"line",snap:false,onSelect:()=>{},onCommit:rows=>{rows[0]!.start.price=999999;}});const p=position(d.start);
    pointer("pointerdown",p.x,p.y);pointer("pointermove",p.x+20,p.y+10);pointer("pointerup",p.x+20,p.y+10);expect(viewport.getDrawings()[0]!.start.price).not.toBe(999999);
  });

  it("trim removing an offscreen original body anchor cancels even if preview anchors survive without range clamping",()=>{
    const d={...trend(),start:{time:bars()[100]!.time,price:202},end:{time:bars()[150]!.time,price:252}};
    viewport.setDrawings([d]);const {onCommit}=interactions(),frame=viewport.getFrame()!,x=frame.timeToX(bars()[130]!.time)!,y=frame.priceToY(232)!;
    pointer("pointerdown",x,y);pointer("pointermove",x+frame.spacing*20,y);expect(viewport.getDrawings()[0]!.start.time).toBe(bars()[120]!.time);
    viewport.setCandles(bars(110,100));expect(viewport.getState().editingDrawing).toBe(false);expect(viewport.getDrawings()).toEqual([d]);pointer("pointerup",x+frame.spacing*20,y);expect(onCommit).not.toHaveBeenCalled();
  });

  it("CSS-scaled canvas placement uses source coordinates rather than backing-pixel coordinates",()=>{
    vi.spyOn(canvas,"getBoundingClientRect").mockReturnValue({left:10,top:20,width:400,height:200,x:10,y:20,right:410,bottom:220,toJSON(){}});
    const placed=vi.fn();interactions(null,true);viewport.setDrawingHandler(placed);const bar=bars()[150]!,frame=viewport.getFrame()!,x=frame.timeToX(bar.time)!,y=frame.priceToY(bar.high)!;
    pointer("pointerdown",x/2,y/2);pointer("pointerup",x/2,y/2);expect(placed).toHaveBeenCalledOnce();expect(placed.mock.calls[0]![0]).toEqual({time:bar.time,price:bar.high});
  });
  it("releasing an edited drawing inside an auxiliary pane cancels its partial preview",()=>{
    viewport.setStudies([{kind:"rsi",period:14,color:"#ffffff"}]);const d=trend(),{point,onCommit}=startDrag(d);pointer("pointermove",point.x+20,point.y+10);const aux=viewport.getPaneLayout()!.panes[0]!;
    pointer("pointerup",point.x+30,aux.top+10);expect(onCommit).not.toHaveBeenCalled();expect(viewport.getDrawings()).toEqual([d]);expect(viewport.getState().editingDrawing).toBe(false);
  });

});
