import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeChartViewport } from "./nativeChartViewport";
import type { ChartAnchor, ChartDrawing } from "./chartWorkspace";
import type { ChartEngineCandle, ChartStructureLine } from "./types";
import type { ChartOverlay } from "../chart-overlays";
import type { SmartChartAnnotation } from "./smartChartAnnotationCanvas";

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


const structure=():ChartStructureLine=>({id:"structure",start:{time:bars()[140]!.time,price:242},end:{time:bars()[160]!.time,price:262},color:"#123abc",width:2});
const annotation=():SmartChartAnnotation=>({id:"pattern",anchors:[{time:bars()[140]!.time,price:242,label:"first"},{time:bars()[160]!.time,price:262,label:"second"}],color:"#456def",dashed:false});
const trade=():ChartOverlay=>({id:"entry",symbol:"TEST",type:"line",price:252,label:"entry",source:"position",color:"#ab1234"});
const scannerLine=()=>({price:252,color:"#cd3456",lineWidth:2 as const,lineStyle:"solid" as const,axisLabelVisible:true,title:"scanner"});
function painted(color:string){return ops.some(op=>op.color===color&&["stroke","fill","arc"].includes(op.name));}
function repaint(){ops=[];flush();}

describe("native overlay real viewport integration",()=>{
 it("keeps separate trade, scanner and structural ownership when one channel clears",()=>{
  viewport.setStructureLines([structure()],[]);viewport.setOverlays([trade()],bars()[199]!.time);const surface=viewport.getScannerOverlaySurface()!;const handle=surface.createPriceLine(scannerLine())!;repaint();
  expect(painted("#123abc")).toBe(true);expect(painted("#ab1234")).toBe(true);expect(painted("#cd3456")).toBe(true);
  viewport.setStructureLines([],[]);repaint();expect(painted("#123abc")).toBe(false);expect(painted("#ab1234")).toBe(true);expect(painted("#cd3456")).toBe(true);
  viewport.setOverlays([],null);repaint();expect(painted("#ab1234")).toBe(false);expect(painted("#cd3456")).toBe(true);
  handle.dispose();repaint();expect(painted("#cd3456")).toBe(false);
 });
 it("annotation owns structure presentation until explicitly cleared",()=>{
  viewport.setStructureLines([structure()],[]);viewport.setSmartAnnotation(annotation());repaint();expect(painted("#456def")).toBe(true);expect(painted("#123abc")).toBe(false);
  viewport.setSmartAnnotation(null);repaint();expect(painted("#456def")).toBe(false);expect(painted("#123abc")).toBe(true);
 });
 it("does not move missing smart anchors or research endpoints to another bar",()=>{
  const a=annotation();a.anchors[0]!.time+=1;viewport.setSmartAnnotation(a);
  const research:ChartOverlay={...trade(),id:"history",source:"research",color:"#ba9876",startTime:bars()[140]!.time+1,endTime:bars()[160]!.time};viewport.setOverlays([research],bars()[199]!.time);repaint();expect(painted(a.color)).toBe(false);expect(painted(research.color!)).toBe(false);
 });
 it("paints exact research endpoints and drops future annotations during prefix replay",()=>{
  const a=annotation();viewport.setSmartAnnotation(a);viewport.setOverlays([{...trade(),source:"research",color:"#ba9876",startTime:bars()[140]!.time,endTime:bars()[160]!.time}],bars()[199]!.time);repaint();expect(painted(a.color)).toBe(true);expect(painted("#ba9876")).toBe(true);
  viewport.setCandles(bars(0,150));repaint();expect(painted(a.color)).toBe(false);expect(painted("#ba9876")).toBe(false);
 });
 it("clears all channels and retained callbacks on context reset",()=>{
  viewport.setStructureLines([structure()],[]);viewport.setSmartAnnotation(annotation());viewport.setOverlays([trade()],bars()[199]!.time);const old=viewport.getScannerOverlaySurface()!;old.createPriceLine(scannerLine());
  viewport.resetContext();viewport.setCandles(bars());viewport.setRange({from:120,to:180});repaint();expect(old.priceToCoordinate(252)).toBeNull();expect(old.createPriceLine(scannerLine())).toBeNull();expect(viewport.getState().overlayLayers).toEqual({structureLines:0,structureMarkers:0,smartAnnotation:false,overlays:0});expect(painted("#ab1234")).toBe(false);expect(painted("#cd3456")).toBe(false);
 });
 it("revokes style lease while old handles cannot remove replacement overlays",()=>{
  const old=viewport.getScannerOverlaySurface()!,handle=old.createPriceLine(scannerLine())!;viewport.setStyle("heikinAshi");const next=viewport.getScannerOverlaySurface()!;expect(next).not.toBe(old);next.createPriceLine(scannerLine());handle.dispose();old.dispose();repaint();expect(painted("#cd3456")).toBe(true);expect(old.coordinateToPrice(100)).toBeNull();
 });
 it("keeps same lease through candle refresh but revokes on destroy",()=>{
  const surface=viewport.getScannerOverlaySurface()!,handle=surface.createPriceLine(scannerLine())!;viewport.setCandles(bars(0,201));expect(viewport.getScannerOverlaySurface()).toBe(surface);viewport.destroy();expect(viewport.getScannerOverlaySurface()).toBeNull();expect(surface.priceToCoordinate(252)).toBeNull();expect(surface.createPriceLine(scannerLine())).toBeNull();expect(()=>handle.dispose()).not.toThrow();
 });
 it.each([false,true])("maps canonical scanner price on HA/log inverted=%s",inverted=>{
  viewport.setStyle("heikinAshi");viewport.setScale("log",inverted);const frame=viewport.getFrame()!,surface=viewport.getScannerOverlaySurface()!;surface.createPriceLine(scannerLine());repaint();const y=frame.priceToY(252)!;expect(surface.priceToCoordinate(252)).toBeCloseTo(y,9);expect(surface.coordinateToPrice(y)).toBeCloseTo(252,9);expect(ops.some(op=>op.color==="#cd3456"&&op.name==="moveTo"&&Math.abs(op.args[1]-y)<1e-8)).toBe(true);
 });
 it("does not interpret auxiliary study coordinates as a scanner price",()=>{
  viewport.setStudies([{kind:"rsi",period:14,color:"#ffffff"}]);const surface=viewport.getScannerOverlaySurface()!,layout=viewport.getPaneLayout()!;expect(surface.coordinateToPrice(layout.panes[0]!.top+10)).toBeNull();expect(surface.coordinateToPrice(-1)).toBeNull();expect(surface.priceToCoordinate(Infinity)).toBeNull();
 });
 it("focus hides analysis, drawings and study panes but preserves trade and scanner overlays",()=>{
  viewport.setStructureLines([structure()],[]);viewport.setDrawings([{...trend(),color:"#f123ab"}]);viewport.setStudies([{kind:"rsi",period:14,color:"#ffffff"}]);viewport.setOverlays([trade()],bars()[199]!.time);viewport.getScannerOverlaySurface()!.createPriceLine(scannerLine());viewport.setAnalysisFocus(true);repaint();expect(viewport.getPaneLayout()!.panes).toHaveLength(0);expect(painted("#123abc")).toBe(false);expect(painted("#f123ab")).toBe(false);expect(painted("#ab1234")).toBe(true);expect(painted("#cd3456")).toBe(true);
  viewport.setAnalysisFocus(false);repaint();expect(viewport.getPaneLayout()!.panes).toHaveLength(1);expect(painted("#123abc")).toBe(true);expect(painted("#f123ab")).toBe(true);
 });
 it("focus cancels edit and disables placement without committing partial geometry",()=>{
  const {point,onCommit}=startDrag();pointer("pointermove",point.x+20,point.y+10);viewport.setAnalysisFocus(true);pointer("pointerup",point.x+20,point.y+10);expect(onCommit).not.toHaveBeenCalled();expect(viewport.getState().editingDrawing).toBe(false);const placed=vi.fn();viewport.setDrawingHandler(placed);pointer("pointerdown",300,100);pointer("pointerup",300,100);expect(placed).not.toHaveBeenCalled();
 });
 it("clones structure, annotation and generic trade inputs before paint",()=>{
  const line=structure(),a=annotation(),t=trade();viewport.setStructureLines([line],[]);viewport.setSmartAnnotation(a);viewport.setOverlays([t],bars()[199]!.time);line.color="#000000";a.color="#000000";a.anchors[0]!.price=99999;t.color="#000000";t.price=99999;repaint();expect(painted("#456def")).toBe(true);expect(painted("#ab1234")).toBe(true);viewport.setSmartAnnotation(null);repaint();expect(painted("#123abc")).toBe(true);
 });
 it("scanner exact-time markers disappear when their observed bar leaves the loaded set",()=>{
  const surface=viewport.getScannerOverlaySurface()!;surface.createMarkers([{time:bars()[140]!.time,color:"#ef9012",position:"aboveBar",shape:"circle",text:"event"}]);repaint();expect(painted("#ef9012")).toBe(true);viewport.setCandles(bars(145,60));viewport.setRange({from:0,to:40});repaint();expect(painted("#ef9012")).toBe(false);
 });
 it("overlay renderability never changes candle/frame autoscale",()=>{
  const before=viewport.getFrame()!;viewport.setOverlays([{...trade(),price:999999}],bars()[199]!.time);viewport.getScannerOverlaySurface()!.createPriceLine({...scannerLine(),price:999999});viewport.setStructureLines([{...structure(),start:{time:bars()[140]!.time,price:999999}}],[]);repaint();const after=viewport.getFrame()!;expect(after.series).toBe(before.series);expect(after.priceToY(252)).toBe(before.priceToY(252));expect(after.series.candles).toHaveLength(200);
 });
 it("holds a whole smart annotation when an explicit segment endpoint is missing",()=>{
  const a=annotation();a.segments=[{from:{time:bars()[140]!.time,price:242},to:{time:bars()[160]!.time+1,price:262}}];viewport.setSmartAnnotation(a);repaint();expect(painted(a.color)).toBe(false);
 });
 it("omits an unavailable optional guide without hiding valid observed anchors",()=>{
  const a=annotation();a.guide={from:{time:bars()[140]!.time,price:242},to:{time:bars()[160]!.time+1,price:262}};viewport.setSmartAnnotation(a);repaint();expect(painted(a.color)).toBe(true);
 });
 it("keeps trade and scanner layers when focus hides a selected smart annotation",()=>{
  viewport.setSmartAnnotation(annotation());viewport.setOverlays([trade()],bars()[199]!.time);viewport.getScannerOverlaySurface()!.createPriceLine(scannerLine());viewport.setAnalysisFocus(true);repaint();expect(painted("#456def")).toBe(false);expect(painted("#ab1234")).toBe(true);expect(painted("#cd3456")).toBe(true);viewport.setAnalysisFocus(false);repaint();expect(painted("#456def")).toBe(true);
 });
 it("keeps canonical marker OHLC geometry under Heikin Ashi",()=>{
  viewport.setStyle("heikinAshi");const f=viewport.getFrame()!,bar=bars()[150]!;viewport.getScannerOverlaySurface()!.createMarkers([{time:bar.time,color:"#ef9012",position:"belowBar",shape:"circle",text:"event"}]);repaint();expect(ops.some(op=>op.color==="#ef9012"&&op.name==="arc"&&Math.abs(op.args[0]-f.timeToX(bar.time)!)<1e-8&&Math.abs(op.args[1]-(f.priceToY(bar.low)!+10))<1e-8)).toBe(true);
 });
 it("preserves authoritative exact research event time instead of latest marker fallback",()=>{
  const frame=viewport.getFrame()!,at=bars()[150]!.time;viewport.setOverlays([{...trade(),type:"marker",source:"research",startTime:at,marker:{side:"BUY"},color:"#ef9012"}],bars()[199]!.time);repaint();expect(ops.some(op=>op.color==="#ef9012"&&op.name==="moveTo"&&Math.abs(op.args[0]-frame.timeToX(at)!)<1e-8)).toBe(true);
  viewport.setOverlays([{...trade(),type:"marker",source:"research",startTime:at+1,marker:{side:"BUY"},color:"#ef9012"}],bars()[199]!.time);repaint();expect(painted("#ef9012")).toBe(false);
 });

});
