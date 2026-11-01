import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {NativeChartViewport} from "./nativeChartViewport";
import {CHART_STYLES} from "./chartWorkspace";
import {heikinAshi} from "./heikinAshi";
const bars=(count=200)=>Array.from({length:count},(_,i)=>({time:1700000000+i*60,open:100+i,high:104+i,low:98+i,close:102+i}));
let host:HTMLDivElement,v:NativeChartViewport,canvas:HTMLCanvasElement,ctx:any,queue:Map<number,FrameRequestCallback>,id:number,ops:Array<{name:string,args:any[],stroke:string}>;
function flush(){const callbacks=[...queue.values()];queue.clear();callbacks.forEach(fn=>fn(0));}
function mount(options:ConstructorParameters<typeof NativeChartViewport>[1]={}){v=new NativeChartViewport(host,options);canvas=host.querySelector('canvas')!;canvas.setPointerCapture=vi.fn();canvas.releasePointerCapture=vi.fn();v.setCandles(bars());v.setRange({from:120,to:180});flush();ops=[];return v;}
function pointer(type:string,x:number,y:number,pointerId=1){const e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});Object.defineProperties(e,{pointerId:{value:pointerId},pointerType:{value:'mouse'}});canvas.dispatchEvent(e);}
function key(key:string){canvas.focus();canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
beforeEach(()=>{queue=new Map();id=0;ops=[];ctx=new Proxy({measureText:(s:string)=>({width:s.length*6})} as any,{get(t,k){if(!(k in t))t[k]=vi.fn((...args:any[])=>ops.push({name:String(k),args,stroke:t.strokeStyle}));return t[k];}});vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx);vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:800,bottom:400,width:800,height:400,toJSON(){}});vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{const n=++id;queue.set(n,fn);return n;});vi.stubGlobal('cancelAnimationFrame',(n:number)=>queue.delete(n));vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({addEventListener(){},removeEventListener(){}}));host=document.createElement('div');document.body.append(host);});
afterEach(()=>{v?.destroy();host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('native adapter viewport bridge',()=>{
 it.each(CHART_STYLES)('%s live line is absent by default and uses only canonical final close when enabled',style=>{
  mount();v.goLatest();v.setStyle(style);flush();expect(ops.filter(o=>o.stroke==='#60a5fa'&&o.name==='stroke')).toHaveLength(0);v.setLivePriceAffordance(true);ops=[];flush();const y=v.getFrame()!.priceToY(bars().at(-1)!.close);expect(ops.filter(o=>o.stroke==='#60a5fa'&&o.name==='stroke')).toHaveLength(1);expect(ops.some(o=>o.stroke==='#60a5fa'&&o.name==='lineTo'&&o.args[1]===y)).toBe(true);expect(ops.filter(o=>o.name==='fillText'&&o.args[0]===String(bars().at(-1)!.close))).toHaveLength(1);v.setLivePriceAffordance(false);ops=[];flush();expect(ops.filter(o=>o.stroke==='#60a5fa'&&o.name==='stroke')).toHaveLength(0);
 });
 it('reset revokes live-price permission until fresh explicit feed verdict',()=>{mount();v.goLatest();v.setLivePriceAffordance(true);flush();v.resetContext();v.setCandles(bars());ops=[];flush();expect(ops.some(o=>o.stroke==='#60a5fa'&&o.name==='stroke')).toBe(false);});
 it('linked cursor uses an exact canonical close under HA and never emits a user crosshair',()=>{
  const onCrosshair=vi.fn();mount({onCrosshair});v.setStyle('heikinAshi');flush();const bar=bars()[150]!;v.setLinkedCrosshair(bar.time);ops=[];flush();const f=v.getFrame()!;expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='moveTo'&&o.args[1]===f.priceToY(bar.close))).toBe(true);expect(onCrosshair).not.toHaveBeenCalled();v.setLinkedCrosshair(bar.time+1);ops=[];flush();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(false);expect(onCrosshair).not.toHaveBeenCalled();
 });
 it('linked cursor withdraws when trimmed or reset without nearest-candle substitution',()=>{
  const onCrosshair=vi.fn();mount({onCrosshair});v.setLinkedCrosshair(bars()[150]!.time);flush();v.setCandles(bars().slice(160));ops=[];flush();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(false);v.resetContext();v.setCandles(bars());ops=[];flush();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(false);expect(onCrosshair).not.toHaveBeenCalled();
 });
 it('canonical accessor is immutable; visible/display accessors are detached exact snapshots',()=>{
  mount();const canonical=v.getCandles();expect(Object.isFrozen(canonical)).toBe(true);expect(Object.isFrozen(canonical[0])).toBe(true);v.setRange({from:140.2,to:145.8});const visible=v.getVisibleCandles();expect(visible.map(b=>b.time)).toEqual(bars().slice(141,146).map(b=>b.time));visible[0]!.close=999;expect(v.getCandles()[141]!.close).toBe(243);expect(v.getDisplayCandle(bars()[141]!.time)).toBeNull();v.setStyle('heikinAshi');const displayed=v.getDisplayCandle(bars()[141]!.time)!;expect(displayed).toEqual(heikinAshi(bars())[141]);displayed.close=999;expect(v.getDisplayCandle(bars()[141]!.time)!.close).not.toBe(999);expect(v.getDisplayCandle(bars()[141]!.time+1)).toBeNull();expect(v.getPricePrecision()).toBe(2);
 });
 it('emits user range changes for pointer, wheel and keys but not setters/data/linked changes',()=>{
  const onUserRangeChange=vi.fn();mount({onUserRangeChange});v.setRange({from:110,to:170});v.setCandles(bars(201));v.setLinkedCrosshair(bars()[120]!.time);flush();expect(onUserRangeChange).not.toHaveBeenCalled();pointer('pointerdown',300,150);pointer('pointermove',320,150);pointer('pointerup',320,150);expect(onUserRangeChange).toHaveBeenCalledTimes(1);expect(onUserRangeChange.mock.calls.at(-1)![0]).toEqual(v.getRange());canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:300,clientY:150,deltaY:-100}));expect(onUserRangeChange).toHaveBeenCalledTimes(2);key('ArrowLeft');key('+');key('Home');key('End');expect(onUserRangeChange).toHaveBeenCalledTimes(6);
 });
 it('user callback can reset context without a stale gesture or range being restored',()=>{
  mount({onUserRangeChange:()=>v.resetContext()});pointer('pointerdown',300,150);pointer('pointermove',320,150);expect(v.getRange()).toBeNull();expect(v.getState().barCount).toBe(0);pointer('pointermove',340,150);pointer('pointerup',340,150);expect(v.getRange()).toBeNull();
 });
 it('incremental updates accept only newest valid observations and preserve canonical/HA history',()=>{
  mount();const prior=v.getCandles(),tip={...bars().at(-1)!,close:301,high:305};expect(v.updateActiveCandle(tip)).toBe(true);expect(v.getCandles()[0]).toBe(prior[0]);expect(v.getCandles().at(-1)).toEqual(tip);expect(prior.at(-1)!.close).toBe(301);const append={...tip,time:tip.time+60,open:301,close:302};expect(v.updateActiveCandle(append)).toBe(true);v.setStyle('heikinAshi');expect(v.getDisplayCandle(append.time)).toEqual(heikinAshi([...bars().slice(0,-1),tip,append]).at(-1));const accepted=v.getCandles();for(const bad of [{...tip,time:tip.time-60},{...append,close:Infinity},{...append,high:1}])expect(v.updateActiveCandle(bad)).toBe(false);expect(v.getCandles()).toBe(accepted);
 });
 it('incremental append follows only a latest view and preserves an inspected range',()=>{
  mount();const range=v.getRange();v.updateActiveCandle(bars(201).at(-1)!);expect(v.getRange()).toEqual(range);v.goLatest();const before=v.getRange()!;v.updateActiveCandle(bars(202).at(-1)!);expect(v.getRange()!.from).toBe(before.from+1);expect(v.getRange()!.to).toBe(before.to+1);
 });
 it('incremental tip never authorizes a last-price label without feed permission',()=>{
  mount();v.goLatest();expect(v.updateActiveCandle({...bars().at(-1)!,close:302,high:305})).toBe(true);ops=[];flush();expect(ops.some(o=>o.stroke==='#60a5fa'&&o.name==='stroke')).toBe(false);v.setLivePriceAffordance(true);ops=[];flush();expect(ops.some(o=>o.name==='fillText'&&o.args[0]==='302')).toBe(true);
 });
 it('incremental refresh callback cannot restore old data after a synchronous context reset',()=>{
  let reset=false;mount({onCrosshair:value=>{if(reset&&value!==null){reset=false;v.resetContext();v.setCandles(bars(10).map(bar=>({...bar,time:bar.time+50000})));}}});v.goLatest();pointer('pointermove',v.getFrame()!.timeToX(bars().at(-1)!.time)!,150);reset=true;expect(v.updateActiveCandle({...bars().at(-1)!,close:302,high:305})).toBe(false);expect(v.getCandles()).toHaveLength(10);expect(v.getCandles()[0]!.time).toBe(bars()[0]!.time+50000);
 });
 it('incremental append preserves an active drawing mapping and commits once',()=>{
  mount();const anchor=bars()[150]!,onCommit=vi.fn(),drawing={id:'level',kind:'horizontal' as const,start:{time:anchor.time,price:anchor.close},color:'#fbbf24'};v.setDrawings([drawing]);v.setDrawingInteraction({selectedId:'level',snap:false,onSelect:vi.fn(),onCommit});const f=v.getFrame()!,x=300,y=f.priceToY(anchor.close)!;pointer('pointerdown',x,y);expect(v.getState().editingDrawing).toBe(true);expect(v.updateActiveCandle({...bars(201).at(-1)!,high:100000})).toBe(true);expect(v.getFrame()!.priceToY(anchor.close)).toBe(y);pointer('pointermove',x,y-20);pointer('pointerup',x,y-20);expect(onCommit).toHaveBeenCalledOnce();expect(v.getDrawings()[0]!.start.price).toBeCloseTo(f.yToPrice(y-20)!,9);
 });
 it('a throwing user range callback is isolated from paint and later interactions',()=>{
  mount({onUserRangeChange:()=>{throw Error('owner failed');}});key('ArrowLeft');flush();expect(v.getState().status).toBe('ready');expect(v.getState().callbackError).toContain('owner failed');const before=v.getRange();key('ArrowRight');expect(v.getRange()).not.toEqual(before);
 });
 it('same-context pinch emits one user change and programmatic setters remain silent',()=>{
  const onUserRangeChange=vi.fn();mount({onUserRangeChange});pointer('pointerdown',200,150,1);pointer('pointerdown',500,150,2);pointer('pointermove',550,150,2);expect(onUserRangeChange).toHaveBeenCalledOnce();pointer('pointerup',200,150,1);pointer('pointerup',550,150,2);v.fit();v.goLatest();v.setStyle('area');flush();expect(onUserRangeChange).toHaveBeenCalledOnce();
 });

 it('incoming linked inspection replaces local hover without echo; later user motion retires it',()=>{
  const onCrosshair=vi.fn();mount({onCrosshair});pointer('pointermove',300,150);expect(onCrosshair).toHaveBeenCalledOnce();const linked=bars()[170]!;v.setLinkedCrosshair(linked.time);ops=[];flush();expect(onCrosshair).toHaveBeenCalledOnce();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='moveTo'&&o.args[1]===v.getFrame()!.priceToY(linked.close))).toBe(true);pointer('pointermove',320,160);canvas.dispatchEvent(new MouseEvent('pointerleave'));ops=[];flush();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(false);expect(v.getState().linkedCrosshairTime).toBeNull();
 });

 it('routine newer ticks preserve a history hover without null link events',()=>{
  const onCrosshair=vi.fn();mount({onCrosshair});const frame=v.getFrame()!,bar=bars()[150]!;pointer('pointermove',frame.timeToX(bar.time)!,150);onCrosshair.mockClear();expect(v.updateActiveCandle({...bars().at(-1)!,close:302,high:305})).toBe(true);ops=[];flush();expect(onCrosshair).not.toHaveBeenCalled();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(true);
 });
 it('a revised hovered tip refreshes its canonical value instead of clearing inspection',()=>{
  const onCrosshair=vi.fn();mount({onCrosshair});v.goLatest();const frame=v.getFrame()!,bar=bars().at(-1)!;pointer('pointermove',frame.timeToX(bar.time)!,150);onCrosshair.mockClear();expect(v.updateActiveCandle({...bar,close:302,high:305})).toBe(true);expect(onCrosshair).toHaveBeenCalledOnce();expect(onCrosshair.mock.calls[0]![0].candle).toMatchObject({time:bar.time,close:302});
 });
 it('symbol precision uses existing FX rules for current and future data without overriding explicit precision',()=>{
  mount();v.setSymbol('EURUSD');expect(v.getPricePrecision()).toBe(5);v.setCandles(bars());expect(v.getPricePrecision()).toBe(5);v.updateActiveCandle({...bars().at(-1)!,close:302,high:305});expect(v.getPricePrecision()).toBe(5);v.setSymbol('USDJPY');expect(v.getPricePrecision()).toBe(3);v.destroy();mount({priceDigits:7});v.setSymbol('EURUSD');expect(v.getPricePrecision()).toBe(7);
 });

 it('notifies subscribers once when paint fails without scheduling a retry loop',()=>{
  const proofs:boolean[]=[];mount({onViewportChange:()=>proofs.push(v.isAnalysisFocusVerified())});expect(proofs.at(-1)).toBe(true);proofs.length=0;ctx.stroke.mockImplementation(()=>{throw Error('renderer failure');});v.setScale('log');flush();expect(v.getState().status).toBe('error');expect(proofs).toEqual([false]);expect(queue.size).toBe(0);flush();expect(proofs).toEqual([false]);ctx.stroke.mockReset();v.setScale('linear');flush();expect(proofs).toEqual([false,true]);
 });

 it('failure notification cannot certify a replacement context before its own successful paint',()=>{
  let replace=false;const proofs:boolean[]=[];
  mount({onViewportChange:()=>{proofs.push(v.isAnalysisFocusVerified());if(replace){replace=false;ctx.stroke.mockReset();v.resetContext();v.setCandles(bars(10));proofs.push(v.isAnalysisFocusVerified());}}});
  proofs.length=0;replace=true;ctx.stroke.mockImplementation(()=>{throw Error('old renderer failure');});v.setScale('log');flush();
  expect(proofs).toEqual([false,false]);expect(v.isAnalysisFocusVerified()).toBe(false);expect(v.getCandles()).toHaveLength(10);expect(queue.size).toBe(1);
  flush();expect(proofs).toEqual([false,false,true]);expect(v.isAnalysisFocusVerified()).toBe(true);expect(queue.size).toBe(0);
 });

 it.each(['refresh','prepend'])('full %s preserves exact timestamp-owned hover without synthetic leave events',kind=>{
  const onCrosshair=vi.fn();mount({onCrosshair});const inspected=bars()[150]!,x=v.getFrame()!.timeToX(inspected.time)!;pointer('pointermove',x,150);onCrosshair.mockClear();
  const next=bars();next.at(-1)!.high=10000;if(kind==='prepend')next.unshift(...bars(20).map(bar=>({...bar,time:bar.time-1200})));
  v.setCandles(next);ops=[];flush();expect(onCrosshair).not.toHaveBeenCalled();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(true);expect(v.getFrame()!.timeToX(inspected.time)).toBeCloseTo(x);
 });
 it('full refresh updates the exact inspected canonical bar and lets callback context replacement win',()=>{
  let reset=false;const seen:any[]=[];mount({onCrosshair:row=>{seen.push(row);if(reset&&row){reset=false;v.resetContext();v.setCandles(bars(10).map(bar=>({...bar,time:bar.time+50000})));}}});
  const inspected=bars()[150]!;pointer('pointermove',v.getFrame()!.timeToX(inspected.time)!,150);seen.length=0;const next=bars();next[150]!.close=253;reset=true;v.setCandles(next);
  expect(seen[0]?.candle).toMatchObject({time:inspected.time,close:253});expect(v.getCandles()).toHaveLength(10);expect(v.getCandles()[0]!.time).toBe(bars()[0]!.time+50000);ops=[];flush();expect(ops.some(o=>o.stroke==='#94a3b8'&&o.name==='stroke')).toBe(false);
 });
 it('full refresh withdraws an inspected timestamp removed from source rather than snapping to another row',()=>{
  const onCrosshair=vi.fn();mount({onCrosshair});pointer('pointermove',v.getFrame()!.timeToX(bars()[150]!.time)!,150);onCrosshair.mockClear();v.setCandles(bars().filter((_,i)=>i!==150));flush();expect(onCrosshair).toHaveBeenCalledOnce();expect(onCrosshair).toHaveBeenCalledWith(null);
 });

});
