import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {NativeChartViewport} from "./nativeChartViewport";
import {CHART_STYLES} from "./chartWorkspace";
const bars=(count=200)=>Array.from({length:count},(_,i)=>({time:1700000000+i*60,open:100+i,high:104+i,low:98+i,close:102+i}));
let host:HTMLDivElement,v:NativeChartViewport,canvas:HTMLCanvasElement,ctx:any,queue:Map<number,FrameRequestCallback>,id:number,ops:Array<{name:string,args:any[],stroke:string}>;
function flush(){const callbacks=[...queue.values()];queue.clear();callbacks.forEach(fn=>fn(0));}
function mount(options:ConstructorParameters<typeof NativeChartViewport>[1]={}){v=new NativeChartViewport(host,options);canvas=host.querySelector('canvas')!;canvas.setPointerCapture=vi.fn();canvas.releasePointerCapture=vi.fn();v.setCandles(bars());v.setRange({from:120,to:180});flush();ops=[];return v;}
function pointer(type:string,x:number,y:number,pointerId=1){const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});Object.defineProperties(e,{pointerId:{value:pointerId},pointerType:{value:'mouse'}});canvas.dispatchEvent(e);}
function key(key:string){canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
beforeEach(()=>{queue=new Map();id=0;ops=[];ctx=new Proxy({measureText:(s:string)=>({width:s.length*6})} as any,{get(t,k){if(!(k in t))t[k]=vi.fn((...args:any[])=>ops.push({name:String(k),args,stroke:t.strokeStyle}));return t[k];}});vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx);vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:800,bottom:400,width:800,height:400,toJSON(){}});vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{const n=++id;queue.set(n,fn);return n;});vi.stubGlobal('cancelAnimationFrame',(n:number)=>queue.delete(n));vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({addEventListener(){},removeEventListener(){}}));host=document.createElement('div');document.body.append(host);});
afterEach(()=>{v?.destroy();host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});

function timePoint(){const layout=v.getPaneLayout()!,last=layout.panes.at(-1)??layout.price;return {x:300,y:last.top+last.height+14};}
function drag(dx=100){const {x,y}=timePoint();pointer('pointerdown',x,y);pointer('pointermove',x+dx,y);pointer('pointerup',x+dx,y);return {x,y};}
function manual(){const f=v.getFrame()!,x=f.plot.left+f.plot.width+30,y=f.plot.top+f.plot.height/2;pointer('pointerdown',x,y);pointer('pointermove',x,y+50);pointer('pointerup',x,y+50);return v.getState().manualPriceRange;}
function dbl(x:number,y:number){canvas.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));}
describe('native time-axis spacing control',()=>{
 it.each(CHART_STYLES)('%s drag changes spacing around original pointer without changing source or vertical bounds',style=>{
  const onUserRangeChange=vi.fn();mount({onUserRangeChange});v.setStyle(style);const fixed=manual(),source=v.getCandles(),start=v.getRange()!,f=v.getFrame()!,{x,y}=timePoint(),anchor=f.xToLogical(x)!;
  pointer('pointerdown',x,y);expect(v.getState().timeAxisDragging).toBe(true);pointer('pointermove',x+100,y);expect(v.getRange()!.to-v.getRange()!.from).toBeLessThan(start.to-start.from);expect(v.getFrame()!.xToLogical(x)).toBeCloseTo(anchor,9);expect(v.getState().manualPriceRange).toEqual(fixed);expect(v.getCandles()).toBe(source);expect(v.isAnalysisFocusVerified()).toBe(false);expect(onUserRangeChange).toHaveBeenCalledOnce();pointer('pointerup',x+100,y);flush();expect(v.getState().timeAxisDragging).toBe(false);expect(v.isAnalysisFocusVerified()).toBe(true);
 });
 it('zero-distance and clamped repeat moves do not manufacture user range events',()=>{
  const changed=vi.fn();mount({onUserRangeChange:changed});const {x,y}=timePoint(),before=v.getRange();pointer('pointerdown',x,y);pointer('pointermove',x,y);expect(v.getRange()).toEqual(before);expect(changed).not.toHaveBeenCalled();pointer('pointermove',x+100000,y);const n=changed.mock.calls.length;pointer('pointermove',x+100000,y);expect(changed).toHaveBeenCalledTimes(n);expect(v.getRange()!.to-v.getRange()!.from).toBeGreaterThanOrEqual(4);
 });
 it('double-click resets horizontal span around the viewed midpoint and keeps manual price limits',()=>{
  const changed=vi.fn();mount({visibleBars:40,onUserRangeChange:changed});const fixed=manual();drag();const r=v.getRange()!,center=(r.from+r.to)/2,{x,y}=timePoint();changed.mockClear();dbl(x,y);expect(v.getRange()!.to-v.getRange()!.from).toBeCloseTo(40);expect((v.getRange()!.from+v.getRange()!.to)/2).toBeCloseTo(center);expect(v.getState().manualPriceRange).toEqual(fixed);expect(changed).toHaveBeenCalledOnce();
 });
 it('uses the bottom axis below oscillator panes, not their price gutters or internal separators',()=>{
  mount();v.setStudies([{kind:'rsi',period:14,color:'#ffffff'}]);flush();const before=v.getRange(),layout=v.getPaneLayout()!;pointer('pointerdown',750,layout.panes[0]!.top+15);pointer('pointermove',790,layout.panes[0]!.top+15);pointer('pointerup',790,layout.panes[0]!.top+15);expect(v.getRange()).toEqual(before);drag();expect(v.getRange()!.to-v.getRange()!.from).toBeLessThan(before!.to-before!.from);
 });
 it('re-resolves the exact observed anchor through prepend and trim while a gesture continues',()=>{
  const changed=vi.fn();mount({onUserRangeChange:changed});const {x,y}=timePoint(),f=v.getFrame()!,logical=f.xToLogical(x)!,index=Math.round(logical),time=bars()[index]!.time,offset=logical-index;pointer('pointerdown',x,y);pointer('pointermove',x+60,y);changed.mockClear();
  const prepended=[...bars(20).map(b=>({...b,time:b.time-1200})),...bars()];v.setCandles(prepended);expect(changed).not.toHaveBeenCalled();expect(v.getFrame()!.xToLogical(x)).toBeCloseTo(index+20+offset,9);pointer('pointermove',x+100,y);expect(v.getFrame()!.xToLogical(x)).toBeCloseTo(index+20+offset,9);
  v.setCandles(prepended.slice(25));expect(v.getState().timeAxisDragging).toBe(true);pointer('pointermove',x+120,y);expect(v.getFrame()!.xToLogical(x)).toBeCloseTo(v.getCandles().findIndex(b=>b.time===time)+offset,9);pointer('pointerup',x+120,y);
 });
 it('insertion within old history preserves exact anchor rather than assuming one uniform first-bar shift',()=>{
  mount();const {x,y}=timePoint(),logical=v.getFrame()!.xToLogical(x)!;pointer('pointerdown',x,y);pointer('pointermove',x+40,y);const revised=bars();revised.splice(10,0,{...revised[9]!,time:revised[9]!.time+30});v.setCandles(revised);expect(v.getFrame()!.xToLogical(x)).toBeCloseTo(logical+1);pointer('pointermove',x+80,y);expect(v.getFrame()!.xToLogical(x)).toBeCloseTo(logical+1);
 });
 it('removed anchor cancels capture rather than choosing another timestamp; tail updates do not move active anchor',()=>{
  mount();v.goLatest();const {x,y}=timePoint(),anchor=v.getFrame()!.barAtX(x)!.time,range=v.getRange();pointer('pointerdown',x,y);v.updateActiveCandle(bars(201).at(-1)!);expect(v.getRange()).toEqual(range);v.setCandles(v.getCandles().filter(b=>b.time!==anchor));expect(v.getState().timeAxisDragging).toBe(false);const after=v.getRange();pointer('pointermove',x+100,y);expect(v.getRange()).toEqual(after);
 });
 it.each(['pointercancel','lostpointercapture','blur','resize','reset','destroy'])('%s revokes capture and prevents later axis movement',action=>{
  mount();const {x,y}=timePoint();pointer('pointerdown',x,y);pointer('pointermove',x+30,y);
  if(action==='blur')window.dispatchEvent(new Event('blur'));else if(action==='resize')v.resize(700,400);else if(action==='reset')v.resetContext();else if(action==='destroy')v.destroy();else pointer(action,x+30,y);
  expect(v.getState().timeAxisDragging).toBe(false);const after=v.getRange();pointer('pointermove',x+100,y);expect(v.getRange()).toEqual(after);
 });
 it('owned outside-canvas pointer fallback and second-pointer suppression cannot steal drawing ownership',()=>{
  mount();canvas.setPointerCapture=vi.fn(()=>{throw Error('no capture');});const {x,y}=timePoint();pointer('pointerdown',x,y);pointer('pointerdown',350,150,2);pointer('pointermove',500,150,2);const before=v.getRange();const event=(kind:string,xx:number)=>{const e=new MouseEvent(kind,{bubbles:true,cancelable:true,clientX:xx,clientY:y,button:0});Object.defineProperty(e,'pointerId',{value:1});window.dispatchEvent(e);};event('pointermove',x+60);expect(v.getRange()).not.toEqual(before);event('pointerup',x+60);expect(v.getState().timeAxisDragging).toBe(false);
  const price=250,py=v.getFrame()!.priceToY(price)!;v.setDrawings([{id:'d',kind:'horizontal',start:{time:bars()[150]!.time,price},color:'#ffffff'}]);const commit=vi.fn();v.setDrawingInteraction({selectedId:'d',snap:false,onSelect:vi.fn(),onCommit:commit});pointer('pointerdown',300,py);expect(v.getState().editingDrawing).toBe(true);pointer('pointerdown',x,y,2);pointer('pointermove',x+100,y,2);expect(v.getState().timeAxisDragging).toBe(false);pointer('pointermove',300,py+10);pointer('pointerup',300,py+10);expect(commit).toHaveBeenCalledOnce();
 });
 it('reentrant source reset from hover withdrawal cannot install the old gesture',()=>{
  let armed=false;mount({onCrosshair:row=>{if(!row&&armed){armed=false;v.resetContext();v.setCandles(bars(10));}}});pointer('pointermove',300,150);armed=true;const {x,y}=timePoint();pointer('pointerdown',x,y);pointer('pointermove',x+80,y);expect(v.getState().timeAxisDragging).toBe(false);expect(v.getCandles()).toHaveLength(10);
 });
 it('a reentrant range callback replaces context without old gesture continuing',()=>{
  let armed=false;mount({onUserRangeChange:()=>{if(armed){armed=false;v.resetContext();v.setCandles(bars(10));}}});const {x,y}=timePoint();armed=true;pointer('pointerdown',x,y);pointer('pointermove',x+80,y);expect(v.getState().timeAxisDragging).toBe(false);expect(v.getCandles()).toHaveLength(10);const after=v.getRange();pointer('pointermove',x+160,y);expect(v.getRange()).toEqual(after);
 });
});
