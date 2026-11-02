import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {NativeChartViewport} from "./nativeChartViewport";
import * as renderer from "./nativePriceRenderer";
import {CHART_STYLES} from "./chartWorkspace";
const bars=(count=200)=>Array.from({length:count},(_,i)=>({time:1700000000+i*60,open:100+i,high:104+i,low:98+i,close:102+i}));
let host:HTMLDivElement,v:NativeChartViewport,canvas:HTMLCanvasElement,ctx:any,queue:Map<number,FrameRequestCallback>,id:number,ops:Array<{name:string,args:any[],stroke:string}>;
function flush(){const callbacks=[...queue.values()];queue.clear();callbacks.forEach(fn=>fn(0));}
function mount(options:ConstructorParameters<typeof NativeChartViewport>[1]={}){v=new NativeChartViewport(host,options);canvas=host.querySelector('canvas')!;canvas.setPointerCapture=vi.fn();canvas.releasePointerCapture=vi.fn();v.setCandles(bars());v.setRange({from:120,to:180});flush();ops=[];return v;}
function pointer(type:string,x:number,y:number,pointerId=1){const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});Object.defineProperties(e,{pointerId:{value:pointerId},pointerType:{value:'mouse'}});canvas.dispatchEvent(e);}
function key(key:string){canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
beforeEach(()=>{queue=new Map();id=0;ops=[];ctx=new Proxy({measureText:(s:string)=>({width:s.length*6})} as any,{get(t,k){if(!(k in t))t[k]=vi.fn((...args:any[])=>ops.push({name:String(k),args,stroke:t.strokeStyle}));return t[k];}});vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx);vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:800,bottom:400,width:800,height:400,toJSON(){}});vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{const n=++id;queue.set(n,fn);return n;});vi.stubGlobal('cancelAnimationFrame',(n:number)=>queue.delete(n));vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({addEventListener(){},removeEventListener(){}}));host=document.createElement('div');document.body.append(host);});
afterEach(()=>{v?.destroy();host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

function axisDrag(dy=80){const f=v.getFrame()!,x=f.plot.left+f.plot.width+30,y=f.plot.top+f.plot.height/2;pointer('pointerdown',x,y);pointer('pointermove',x,y+dy);pointer('pointerup',x,y+dy);return {x,y};}
function bounds(){const f=v.getFrame()!,a=f.yToPrice(f.plot.top)!,b=f.yToPrice(f.plot.top+f.plot.height)!;return {min:Math.min(a,b),max:Math.max(a,b)};}
describe('native real-price axis',()=>{
 it.each(['linear','log','percent','indexed'] as const)('manual %s bounds preserve canonical source and invertible actual-price geometry',scale=>{
  const data=renderer.prepareNativePriceSeries(bars());for(const inverted of [false,true]){
   const result=renderer.createNativePriceFrame(data,{plot:{left:8,top:8,width:700,height:350},range:{from:120,to:180},style:'heikinAshi',scale,inverted,referencePrice:100,priceRange:{min:150,max:350}});expect(result.ok).toBe(true);if(!result.ok)return;
   const f=result.frame;expect(f.yToPrice(f.plot.top)).toBeCloseTo(inverted?150:350,9);expect(f.yToPrice(f.plot.top+f.plot.height)).toBeCloseTo(inverted?350:150,9);expect(f.yToPrice(f.priceToY(253)!)).toBeCloseTo(253,9);expect(f.series).toBe(data);
  }
 });
 it('rejects degenerate/nonfinite/log-invalid manual bounds instead of silently auto fitting',()=>{
  for(const priceRange of [{min:100,max:100},{min:200,max:100},{min:NaN,max:200},{min:100,max:Infinity},{min:0,max:200}])expect(renderer.createNativePriceFrame(renderer.prepareNativePriceSeries(bars()),{plot:{left:8,top:8,width:700,height:350},range:{from:120,to:180},style:'candles',scale:'log',priceRange}).ok).toBe(false);
 });
 it('scales normalized finite extremes and log space without corrupting source units',()=>{
  expect(renderer.scaleNativePriceRange({min:-1e300,max:1e300},'linear',2)).toEqual({min:-2e300,max:2e300});
  const log=renderer.scaleNativePriceRange({min:1,max:100},'log',2)!;expect(log.min).toBeCloseTo(.1,12);expect(log.max).toBeCloseTo(1000,8);
  expect(renderer.scaleNativePriceRange({min:1e308,max:1.7e308},'linear',100)).toBeNull();expect(renderer.scaleNativePriceRange({min:1,max:1+Number.EPSILON},'linear',.001)).toBeNull();
 });
 it.each(['linear','log','percent','indexed'] as const)('axis drag scales %s only; double-click restores auto without horizontal link events',scale=>{
  const onUserRangeChange=vi.fn();mount({onUserRangeChange});v.setScale(scale,true);flush();const prior=bounds(),range=v.getRange(),candles=v.getCandles();const {x,y}=axisDrag();flush();expect(v.getState().manualPriceRange).not.toBeNull();expect(bounds().max-bounds().min).toBeGreaterThan(prior.max-prior.min);expect(v.getRange()).toEqual(range);expect(v.getCandles()).toBe(candles);expect(onUserRangeChange).not.toHaveBeenCalled();
  canvas.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));expect(v.getState().manualPriceRange).toBeNull();expect(bounds().min).toBeCloseTo(prior.min,8);expect(bounds().max).toBeCloseTo(prior.max,8);expect(v.getRange()).toEqual(range);
 });
 it('manual bounds persist across tick, prepend, horizontal pan, resize and same scale/style settings',()=>{
  mount();axisDrag();const fixed=bounds();v.updateActiveCandle({...bars().at(-1)!,high:100000});v.setCandles([...bars(20).map(b=>({...b,time:b.time-1200})),...bars()]);v.setRange({from:30,to:90});v.resize(700,500);v.setStyle('candles');v.setScale('linear');expect(bounds().min).toBeCloseTo(fixed.min,8);expect(bounds().max).toBeCloseTo(fixed.max,8);expect(v.getState().manualPriceRange).not.toBeNull();
 });
 it('incompatible scale/style/context and explicit auto policy restore auto bounds',()=>{
  mount();axisDrag();v.setStyle('heikinAshi');expect(v.getState().manualPriceRange).toBeNull();axisDrag();v.setScale('log');expect(v.getState().manualPriceRange).toBeNull();axisDrag();v.setPriceOnlyScale(true);expect(v.getState().manualPriceRange).toBeNull();axisDrag();v.resetContext();v.setCandles(bars());expect(v.getState().manualPriceRange).toBeNull();
 });
 it('axis ownership excludes oscillator gutters, time axis, secondary pointers and active drawing gestures',()=>{
  mount();v.setStudies([{kind:'rsi',period:14,color:'#ffffff'}]);flush();const pane=v.getPaneLayout()!.panes[0]!,x=pane.left+pane.width+30,y=pane.top+pane.height/2;pointer('pointerdown',x,y);pointer('pointermove',x,y+30);pointer('pointerup',x,y+30);expect(v.getState().manualPriceRange).toBeNull();
  pointer('pointerdown',x,395);pointer('pointermove',x,430);pointer('pointerup',x,430);expect(v.getState().manualPriceRange).toBeNull();
  const price=v.getFrame()!.plot,py=price.top+price.height/2;pointer('pointerdown',x,py,1);pointer('pointerdown',200,py,2);pointer('pointermove',x,py+30,2);expect(v.getState().manualPriceRange).toBeNull();pointer('pointermove',x,py+30,1);expect(v.getState().manualPriceRange).not.toBeNull();pointer('pointerup',x,py+30,1);
 });
 it('in-progress axis scaling keeps original price baseline across appended ticks',()=>{
  mount();const f=v.getFrame()!,x=f.plot.left+f.plot.width+30,y=150;pointer('pointerdown',x,y);pointer('pointermove',x,y+30);const first=bounds();v.updateActiveCandle({...bars().at(-1)!,high:1e9});pointer('pointermove',x,y+30);expect(bounds()).toEqual(first);pointer('pointermove',x,y+60);expect(bounds().max-bounds().min).toBeGreaterThan(first.max-first.min);pointer('pointerup',x,y+60);
 });
 it.each(['pointercancel','lostpointercapture','blur'])('%s ends price-axis capture and ignores later movements',kind=>{
  mount();const f=v.getFrame()!,x=f.plot.left+f.plot.width+30,y=150;pointer('pointerdown',x,y);pointer('pointermove',x,y+30);expect(v.getState().priceAxisDragging).toBe(true);if(kind==='blur')window.dispatchEvent(new Event('blur'));else pointer(kind,x,y+30);const fixed=bounds();pointer('pointermove',x,y+120);expect(v.getState().priceAxisDragging).toBe(false);expect(bounds()).toEqual(fixed);
 });
 it('reentrant hover withdrawal cannot install an old axis gesture after reset',()=>{
  let armed=false;mount({onCrosshair:value=>{if(!value&&armed){armed=false;v.resetContext();v.setCandles(bars(10));}}});pointer('pointermove',300,150);armed=true;const f=v.getFrame()!,x=f.plot.left+f.plot.width+30;pointer('pointerdown',x,150);pointer('pointermove',x,200);expect(v.getState().priceAxisDragging).toBe(false);expect(v.getState().manualPriceRange).toBeNull();expect(v.getCandles()).toHaveLength(10);
 });
 it.each(CHART_STYLES)('%s manual frame keeps exact-price scanner and drawing coordinates aligned',style=>{
  mount();v.setStyle(style);axisDrag();const frame=v.getFrame()!,price=250,y=frame.priceToY(price)!;expect(frame.yToPrice(y)).toBeCloseTo(price,8);expect(v.getScannerOverlaySurface()!.priceToCoordinate(price)).toBe(y);
  const onCommit=vi.fn();v.setDrawings([{id:'level',kind:'horizontal',start:{time:bars()[150]!.time,price},color:'#fbbf24'}]);v.setDrawingInteraction({selectedId:'level',snap:false,onSelect:vi.fn(),onCommit});pointer('pointerdown',300,y);expect(v.getState().editingDrawing).toBe(true);pointer('pointerdown',750,150,2);pointer('pointermove',750,200,2);expect(v.getState().priceAxisDragging).toBe(false);pointer('pointermove',300,y+10);pointer('pointerup',300,y+10);expect(onCommit).toHaveBeenCalledOnce();expect(v.getDrawings()[0]!.start.price).toBeCloseTo(frame.yToPrice(y+10)!,8);
 });
 it('owned window fallback finishes axis scaling when pointer capture fails; resize and destroy revoke late gestures',()=>{
  mount();canvas.setPointerCapture=vi.fn(()=>{throw Error('capture unavailable');});const f=v.getFrame()!,x=f.plot.left+f.plot.width+30,y=150;
  pointer('pointerdown',x,y);const outside=(type:string,py:number)=>{const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:py,button:0});Object.defineProperty(e,'pointerId',{value:1});window.dispatchEvent(e);};outside('pointermove',200);expect(v.getState().manualPriceRange).not.toBeNull();outside('pointerup',200);expect(v.getState().priceAxisDragging).toBe(false);
  pointer('pointerdown',x,y);v.resize(700,500);expect(v.getState().priceAxisDragging).toBe(false);const fixed=bounds();outside('pointermove',260);expect(bounds()).toEqual(fixed);v.destroy();outside('pointermove',300);expect(v.getState().status).toBe('destroyed');expect(queue.size).toBe(0);
 });

});
