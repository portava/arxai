import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeChartViewport } from "./nativeChartViewport";
import { CHART_STYLES } from "./chartWorkspace";
import * as renderer from "./nativePriceRenderer";
import type { ChartEngineCandle } from "./types";
import { StudyCalculator, STUDY_DEFAULTS } from "./chartStudies";

const candles = (start = 0, count = 200): ChartEngineCandle[] => Array.from({length:count}, (_,i) => ({time:1_700_000_000+(start+i)*60,open:100+start+i,high:103+start+i,low:99+start+i,close:102+start+i}));
let container:HTMLDivElement, viewport:NativeChartViewport, canvas:HTMLCanvasElement, ctx:any;
let width=800,height=400,nextRaf=1;
let queue:Map<number,FrameRequestCallback>, allCallbacks:FrameRequestCallback[];
let observers:Array<{callback:ResizeObserverCallback;disconnect:ReturnType<typeof vi.fn>}>;
let media:Array<{callback:((event:any)=>void)|null;removeEventListener:ReturnType<typeof vi.fn>}>;
function flush() { const callbacks=[...queue.values()];queue.clear();callbacks.forEach(callback=>callback(1)); }
function create(options:ConstructorParameters<typeof NativeChartViewport>[1]={}) {
  viewport=new NativeChartViewport(container,options);canvas=container.querySelector('canvas')!;
  canvas.setPointerCapture=vi.fn();canvas.releasePointerCapture=vi.fn();viewport.setCandles(candles());flush();return viewport;
}
function pointer(type:string,x:number,y:number,id=1,pointerType='mouse') {
  const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x+10,clientY:y+20,button:0});
  Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:pointerType}});canvas.dispatchEvent(event);return event;
}
function wheel(x:number,y:number,deltaY:number,deltaMode=0,deltaX=0) {
  const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:x+10,clientY:y+20,deltaY,deltaX,deltaMode});canvas.dispatchEvent(event);return event;
}
function key(value:string,target:HTMLElement=canvas,options:KeyboardEventInit={}) {const e=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:value,...options});target.dispatchEvent(e);return e;}
beforeEach(()=>{
  width=800;height=400;nextRaf=1;queue=new Map();allCallbacks=[];observers=[];media=[];
  ctx=new Proxy({measureText:vi.fn((text:string)=>({width:text.length*6}))} as any,{get:(target,key)=>{if(!(key in target))target[key]=vi.fn();return target[key];},set:(target,key,value)=>{target[key]=value;return true;}});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx);
  vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,fixture');
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    const w=this instanceof HTMLCanvasElement?parseFloat(this.style.width):width;
    const h=this instanceof HTMLCanvasElement?parseFloat(this.style.height):height;
    return {x:10,y:20,left:10,top:20,right:10+w,bottom:20+h,width:w,height:h,toJSON(){}};
  });
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=nextRaf++;queue.set(id,callback);allCallbacks.push(callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>queue.delete(id));
  vi.stubGlobal('ResizeObserver',class{callback:ResizeObserverCallback;disconnect=vi.fn();constructor(callback:ResizeObserverCallback){this.callback=callback;observers.push(this);}observe(){}});
  vi.stubGlobal('matchMedia',vi.fn(()=>{const value={callback:null as ((event:any)=>void)|null,addEventListener:vi.fn((_name:string,callback:(event:any)=>void)=>{value.callback=callback;}),removeEventListener:vi.fn()};media.push(value);return value;}));
  vi.stubGlobal('devicePixelRatio',2);
  container=document.createElement('div');document.body.append(container);
});
afterEach(()=>{viewport?.destroy();container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});


describe('maximized native indicator pane',()=>{
 const configs=[{id:'rsi',kind:'rsi' as const,period:14,color:'#ffffff',paneWeight:2},{id:'atr',kind:'atr' as const,period:14,color:'#00ff00',paneWeight:.7}];
 function ready(){create();viewport.setStudies(configs);flush();}
 it('fills the plot with only the selected pane and restores exact saved geometry and observations',()=>{
  ready();const before=viewport.getPaneLayout(),range=viewport.getRange(),values=viewport.getStudyValues(candles().at(-1)!.time),bars=viewport.getFrame()!.series.candles;
  const pricePaint=vi.spyOn(renderer,'paintNativePriceLayer');ctx.fillText.mockClear();
  expect(viewport.setMaximizedStudyPane('rsi')).toBe(true);flush();
  expect(viewport.getState().maximizedStudyPane).toBe('rsi');
  expect(viewport.getStudyPaneControls()).toEqual([expect.objectContaining({id:'rsi',maximized:true,resizable:false,top:8,height:360})]);
  expect(pricePaint).not.toHaveBeenCalled();
  const labels=ctx.fillText.mock.calls.map((a:any[])=>String(a[0]));
  expect(labels.some((s:string)=>s.includes('RSI'))).toBe(true);expect(labels.some((s:string)=>s.includes('ATR'))).toBe(false);
  expect(viewport.getRange()).toEqual(range);expect(viewport.getFrame()!.series.candles).toBe(bars);expect(viewport.getStudyValues(candles().at(-1)!.time)).toEqual(values);
  expect(viewport.getStudies()).toEqual(configs);expect(viewport.beginStudyPaneResize('rsi')).toBeNull();
  expect(viewport.setMaximizedStudyPane(null)).toBe(true);flush();expect(viewport.getPaneLayout()).toEqual(before);expect(pricePaint).toHaveBeenCalled();
 });
 it('withdraws old scanner coordinates and does not interpret indicator units as price',()=>{
  const onCrosshair=vi.fn();create({onCrosshair});viewport.setStudies(configs);flush();const oldSurface=viewport.getScannerOverlaySurface()!;
  viewport.setMaximizedStudyPane('rsi');flush();expect(viewport.getScannerOverlaySurface()).toBeNull();expect(oldSurface.priceToCoordinate(250)).toBeNull();expect(oldSurface.coordinateToPrice(150)).toBeNull();
  pointer('pointermove',200,160);expect(onCrosshair).toHaveBeenLastCalledWith(expect.objectContaining({price:null}));
  viewport.inspectCandle('last');expect(onCrosshair).toHaveBeenLastCalledWith(expect.objectContaining({price:null}));
  pointer('pointerdown',780,160);pointer('pointermove',780,190);pointer('pointerup',780,190);expect(viewport.getState().manualPriceRange).toBeNull();
  const range=viewport.getRange()!;wheel(200,160,-100);flush();expect(viewport.getRange()!.to-viewport.getRange()!.from).toBeLessThan(range.to-range.from);
 });
 it('only accepts current painted owners and restores on removal, collapse, timeframe and reset',()=>{
  create();viewport.setStudies(configs);expect(viewport.setMaximizedStudyPane('rsi')).toBe(false);flush();expect(viewport.setMaximizedStudyPane('missing')).toBe(false);
  for(const change of [()=>viewport.setStudies([configs[1]!]),()=>viewport.setStudies([{...configs[0]!,paneCollapsed:true},configs[1]!]),()=>viewport.setDisplayTimeZone('UTC','M5'),()=>viewport.resetContext()]){
   viewport.setCandles(candles());viewport.setStudies(configs);flush();expect(viewport.setMaximizedStudyPane('rsi')).toBe(true);flush();change();flush();expect(viewport.getState().maximizedStudyPane).toBeNull();
  }
 });
 it('drawing placement restores the price pane before accepting price anchors',()=>{
  ready();viewport.setMaximizedStudyPane('rsi');flush();const onPlace=vi.fn();viewport.setDrawingHandler(onPlace);flush();expect(viewport.getState().maximizedStudyPane).toBeNull();
 });
 it('price-only focus clears maximization and does not revive it on return',()=>{
  ready();viewport.setMaximizedStudyPane('rsi');flush();viewport.setAnalysisFocus(true);flush();expect(viewport.getState().maximizedStudyPane).toBeNull();viewport.setAnalysisFocus(false);flush();expect(viewport.getStudyPaneControls()).toHaveLength(2);
 });
});
