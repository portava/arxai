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

describe('native study viewport integration',()=>{
  it('lays out independent oscillator panes while preserving the price history window',()=>{
    create();const range=viewport.getRange();viewport.setStudies(STUDY_DEFAULTS);flush();
    expect(viewport.getState()).toMatchObject({status:'ready',paneCount:2});
    expect(viewport.getRange()).toEqual(range);
    const layout=viewport.getPaneLayout()!;
    expect(layout.price.height).toBeGreaterThan(layout.panes[0]!.height);
    expect(layout.panes[0]!.top).toBeGreaterThanOrEqual(layout.price.top+layout.price.height);
    expect(layout.panes[1]!.top).toBeGreaterThanOrEqual(layout.panes[0]!.top+layout.panes[0]!.height);
    expect(ctx.fillText.mock.calls.some((args:any[])=>String(args[0]).includes('RSI'))).toBe(true);
  });
  it('uses canonical study values across HA, log and inverted price rendering',()=>{
    create();viewport.setStudies(STUDY_DEFAULTS);const time=candles().at(-1)!.time;
    const expected=viewport.getStudyValues(time);
    viewport.setStyle('heikinAshi');viewport.setScale('log',true);flush();
    expect(viewport.getState().status).toBe('ready');expect(viewport.getStudyValues(time)).toEqual(expected);
    const rsi=new StudyCalculator(STUDY_DEFAULTS.find(s=>s.kind==='rsi')!);rsi.calculate(candles());
    expect(expected.find(s=>s.label.startsWith('RSI'))!.values[0]!.value).toBe(rsi.points.at(-1)!.values[0]);
  });
  it('allows navigation and canonical crosshair in a pane without treating oscillator units as price',()=>{
    const onCrosshair=vi.fn();create({onCrosshair});viewport.setStudies([STUDY_DEFAULTS.find(s=>s.kind==='rsi')!]);flush();
    const pane=viewport.getPaneLayout()!.panes[0]!,y=pane.top+pane.height/2;
    pointer('pointermove',200,y);expect(onCrosshair).toHaveBeenLastCalledWith(expect.objectContaining({price:null,candle:expect.objectContaining({open:expect.any(Number)})}));
    const before=viewport.getRange()!;wheel(200,y,-100);flush();expect(viewport.getRange()!.to-viewport.getRange()!.from).toBeLessThan(before.to-before.from);
  });
  it('reports inadequate pane space instead of silently dropping selected studies',()=>{
    create();viewport.setStudies(Array.from({length:12},(_,i)=>({...STUDY_DEFAULTS.find(s=>s.kind==='rsi')!,id:'rsi-'+i})));flush();
    expect(viewport.getState()).toMatchObject({status:'unavailable',paneCount:12,error:'INSUFFICIENT_PANE_SPACE_OR_UNSUPPORTED_DIMENSIONS'});
    viewport.resize(800,1000);flush();expect(viewport.getState()).toMatchObject({status:'ready',paneCount:12});
  });
  it('keeps missing volume blank and carries exact tick evidence, including a real zero',()=>{
    create();viewport.setStudies([{kind:'tick_volume',period:1,color:'#38bdf8'}]);const data=candles();
    data.at(-1)!.volumeEvidence={kind:'tick_count',quantity:0,unit:'ticks',reason:null};viewport.setCandles(data);flush();
    expect(viewport.getStudyValues(data.at(-1)!.time)[0]!.values[0]!.value).toBe(0);
    expect(viewport.getStudyValues(data.at(-2)!.time)[0]!.values[0]!.value).toBeNull();
    delete data.at(-1)!.volumeEvidence;viewport.setCandles(data);flush();
    expect(viewport.getStudyValues(data.at(-1)!.time)[0]!.values[0]!.value).toBeNull();
  });
  it('context reset removes old study values and replay truncation removes future points',()=>{
    create();viewport.setStudies(STUDY_DEFAULTS);const data=candles(),future=data.at(-1)!.time;
    viewport.setCandles(data.slice(0,50));flush();expect(viewport.getStudyValues(future).every(s=>s.values.every(v=>v.value===null))).toBe(true);
    viewport.resetContext();flush();expect(viewport.getStudyValues(data[20]!.time).every(s=>s.values.every(v=>v.value===null))).toBe(true);
    expect(viewport.getState().barCount).toBe(0);
  });
  it('withdraws old hover coordinates and gestures when study autoscale changes',()=>{
    const onCrosshair=vi.fn();create({onCrosshair});viewport.setStudies([{kind:'sma',period:200,color:'#fff'}]);viewport.setRange({from:180,to:199});flush();
    pointer('pointermove',200,100);expect(onCrosshair.mock.calls.at(-1)![0]).not.toBeNull();
    viewport.setPriceOnlyScale(true);expect(onCrosshair).toHaveBeenLastCalledWith(null);
    pointer('pointerdown',200,100);viewport.setPriceOnlyScale(false);const before=viewport.getRange();pointer('pointermove',300,100);expect(viewport.getRange()).toEqual(before);
  });
  it('a reentrant price-only toggle supersedes an older context mutation',()=>{
    create({onCrosshair:value=>{if(value===null)viewport.setPriceOnlyScale(true);}});pointer('pointermove',200,100);
    const old=viewport.getFrame()!.series.candles;viewport.setCandles(candles(400));
    expect(viewport.getState().priceOnlyScale).toBe(true);expect(viewport.getFrame()!.series.candles).toBe(old);
  });
});

describe('native Canvas viewport lifecycle and source ownership',()=>{
  it('owns one Canvas and coalesces data, style and view changes into one paint',()=>{
    viewport=new NativeChartViewport(container);canvas=container.querySelector('canvas')!;
    viewport.setCandles(candles());viewport.setStyle('line');viewport.setRange({from:20,to:80});
    expect(container.querySelectorAll('canvas')).toHaveLength(1);expect(queue.size).toBe(1);expect(viewport.getState().paintCount).toBe(0);
    flush();expect(viewport.getState().paintCount).toBe(1);expect(queue.size).toBe(0);
    expect(canvas.width).toBe(1600);expect(canvas.height).toBe(800);expect(ctx.setTransform).toHaveBeenCalledWith(2,0,0,2,0,0);
    expect(viewport.getFrame()!.range).toEqual({from:20,to:80});
  });
  it.each(CHART_STYLES)('renders %s without modifying canonical observations',style=>{
    create();const input=candles(),original=structuredClone(input);viewport.setCandles(input);viewport.setStyle(style);flush();
    expect(viewport.getFrame()!.style).toBe(style);expect(viewport.getFrame()!.series.candles).toEqual(original);expect(input).toEqual(original);
    input[0]!.close=999;expect(viewport.getFrame()!.series.candles[0]!.close).toBe(original[0]!.close);
  });
  it('crosshair returns real canonical OHLC even for HA and does not reprepare history',()=>{
    const notify=vi.fn();create({onCrosshair:notify});viewport.setStyle('heikinAshi');flush();
    const spy=vi.spyOn(renderer,'prepareNativePriceSeries');const frame=viewport.getFrame()!,bar=frame.series.candles[150]!;
    const x=frame.timeToX(bar.time)!;pointer('pointermove',x,100);flush();
    expect(notify.mock.calls.at(-1)![0].candle).toEqual(bar);expect(notify.mock.calls.at(-1)![0].candle.close).not.toBe(frame.series.heikinAshi[150]!.close);
    for(let i=0;i<20;i++)pointer('pointermove',x,110+i);flush();expect(spy).not.toHaveBeenCalled();
    pointer('pointerleave',x,100);expect(notify).toHaveBeenLastCalledWith(null);
  });
  it('preserves real timestamp position through prepend and rolling history while panned',()=>{
    create();viewport.setRange({from:30,to:90});const anchor=candles()[60]!.time;const x=viewport.getFrame()!.timeToX(anchor);
    viewport.setCandles(candles(-40,240));expect(viewport.getRange()).toEqual({from:70,to:130});expect(viewport.getFrame()!.timeToX(anchor)).toBeCloseTo(x!);
    viewport.setCandles(candles(20,200));expect(viewport.getRange()).toEqual({from:10,to:70});expect(viewport.getFrame()!.timeToX(anchor)).toBeCloseTo(x!);
    viewport.setCandles(candles(20,201));expect(viewport.getRange()).toEqual({from:10,to:70});
  });
  it('only follows appended latest bars when following latest was explicitly retained',()=>{
    create();const span=viewport.getRange()!.to-viewport.getRange()!.from;const before=viewport.getRange()!;
    viewport.setCandles(candles(0,201));expect(viewport.getRange()!.from).toBe(before.from+1);
    viewport.setRange({from:20,to:60});viewport.setCandles(candles(0,202));expect(viewport.getRange()).toEqual({from:20,to:60});
    viewport.goLatest();expect(viewport.getState().followingLatest).toBe(true);expect(viewport.getRange()!.to).toBe(203);expect(span).toBe(100);
  });
  it('keeps percentage/indexed reference fixed through pan, prepend and refresh until context reset',()=>{
    create();const reference=candles()[0]!.close;viewport.setScale('percent');viewport.setRange({from:25,to:85});
    viewport.setCandles(candles(-50,250));expect(viewport.getState().referencePrice).toBe(reference);expect(viewport.getFrame()!.axisValue(reference)).toBe(0);
    viewport.setScale('indexed');expect(viewport.getFrame()!.axisValue(reference)).toBe(100);
    viewport.resetContext();expect(viewport.getState().referencePrice).toBeNull();viewport.setCandles(candles(500,50));expect(viewport.getState().referencePrice).toBe(candles(500,50)[0]!.close);
  });
  it('does not substitute a positive later close for a zero first reference',()=>{
    create();viewport.resetContext();viewport.setCandles([{time:1,open:0,high:1,low:-1,close:0},{time:2,open:1,high:3,low:1,close:2}]);viewport.setScale('percent');flush();
    expect(viewport.getState().referencePrice).toBe(0);expect(viewport.getState()).toMatchObject({status:'unavailable',error:'INVALID_SCALE'});expect(viewport.exportImage()).toBeNull();
  });
  it('daily display stays UTC without changing source timestamps',()=>{
    create();viewport.setSourceClockQualified(true);const time=viewport.getFrame()!.series.candles[0]!.time;viewport.setDisplayTimeZone('America/New_York','D1');
    expect(viewport.getState().effectiveTimeZone).toBe('UTC');viewport.setDisplayTimeZone('America/New_York','M5');expect(viewport.getState().effectiveTimeZone).toBe('America/New_York');expect(viewport.getFrame()!.series.candles[0]!.time).toBe(time);
  });
  it('zero/invalid sizes safely withhold frames and resize restores current source',()=>{
    create();viewport.resize(0,0);flush();expect(viewport.getState()).toMatchObject({status:'unavailable',error:'ZERO_SIZE_OR_UNSUPPORTED_DIMENSIONS'});
    viewport.resize(Infinity,400);expect(viewport.getFrame()).toBeNull();viewport.resize(800,400);flush();expect(viewport.getState().status).toBe('ready');
  });
  it('bounds untrusted backing allocations and exposes clamped effective DPR',()=>{
    create();vi.stubGlobal('devicePixelRatio',1e100);viewport.resize(800,400);
    expect(canvas.width).toBeLessThanOrEqual(8192);expect(canvas.height).toBeLessThanOrEqual(8192);expect(canvas.width*canvas.height).toBeLessThanOrEqual(16_777_216);
    expect(viewport.getState().pixelRatio).toBeLessThan(1e100);viewport.resize(1e100,1e100);expect(canvas.width*canvas.height).toBe(0);expect(viewport.getFrame()).toBeNull();
  });
  it('reacts to ResizeObserver and DPR changes, then disconnects every retained callback',()=>{
    create();const observer=observers[0]!,oldMedia=media.at(-1)!,oldRaf=[...allCallbacks];
    width=600;height=300;observer.callback([],observer as unknown as ResizeObserver);flush();expect(viewport.getState().width).toBe(600);
    vi.stubGlobal('devicePixelRatio',3);oldMedia.callback?.({});flush();expect(canvas.width).toBe(1800);
    const paints=viewport.getState().paintCount;viewport.destroy();expect(observer.disconnect).toHaveBeenCalledOnce();expect(media.at(-1)!.removeEventListener).toHaveBeenCalled();expect(container.querySelector('canvas')).toBeNull();
    observer.callback([],observer as unknown as ResizeObserver);oldMedia.callback?.({});oldRaf.forEach(callback=>callback(1));flush();
    expect(viewport.getState().paintCount).toBe(paints);expect(viewport.getFrame()).toBeNull();expect(queue.size).toBe(0);
  });
  it('reset invalidates old scheduled callbacks and export flushes one current paint',()=>{
    create();viewport.setStyle('line');const old=allCallbacks.at(-1)!;viewport.resetContext();viewport.setCandles(candles(400,50));
    old(1);expect(viewport.exportImage()).toBe('data:image/png;base64,fixture');expect(queue.size).toBe(0);expect(viewport.getFrame()!.series.candles[0]!.time).toBe(candles(400,50)[0]!.time);
  });
  it('caller callback failures cannot clear valid paint or interrupt cleanup',()=>{
    create({onCrosshair:()=>{throw Error('consumer failed');},onViewportChange:()=>{throw Error('observer failed');}});
    expect(viewport.getState().status).toBe('ready');expect(viewport.getState().callbackError).toContain('observer failed');
    pointer('pointermove',200,100);expect(()=>viewport.resetContext()).not.toThrow();viewport.setCandles(candles());flush();pointer('pointermove',200,100);
    expect(()=>viewport.destroy()).not.toThrow();expect(observers[0]!.disconnect).toHaveBeenCalledOnce();expect(queue.size).toBe(0);
  });
});

describe('native chart pointer, wheel and keyboard navigation',()=>{
  beforeEach(()=>{create();viewport.setRange({from:40,to:100});flush();});
  it('pans a real window using captured pointer coordinates and cancels on resize',()=>{
    const before=viewport.getRange()!,spacing=viewport.getFrame()!.spacing;
    pointer('pointerdown',300,100);pointer('pointermove',300+spacing*5,100);expect(viewport.getRange()!.from).toBeCloseTo(before.from-5);
    viewport.resize(700,400);const resized=viewport.getRange();pointer('pointermove',600,100);expect(viewport.getRange()).toEqual(resized);
  });
  it('anchors wheel zoom to the same logical observation and honors line delta mode',()=>{
    const frame=viewport.getFrame()!,x=frame.plot.width*.25,anchor=frame.xToLogical(x)!;
    const event=wheel(x,100,-3,1);expect(event.defaultPrevented).toBe(true);expect(viewport.getFrame()!.xToLogical(x)).toBeCloseTo(anchor,10);
    expect(viewport.getRange()!.to-viewport.getRange()!.from).toBeLessThan(60);
  });
  it('horizontal wheel pans without zoom and outside-plot wheel leaves page scroll alone',()=>{
    const frame=viewport.getFrame()!,before=viewport.getRange()!;wheel(200,100,0,0,frame.spacing*4);
    expect(viewport.getRange()!.from).toBeCloseTo(before.from+4);expect(viewport.getRange()!.to-viewport.getRange()!.from).toBe(60);
    const prior=viewport.getRange();expect(wheel(790,100,-100).defaultPrevented).toBe(false);expect(viewport.getRange()).toEqual(prior);
  });
  it('two-pointer pinch zooms about its moving midpoint without fabricating timestamps',()=>{
    const frame=viewport.getFrame()!,anchor=frame.xToLogical(300)!;
    pointer('pointerdown',200,100,1,'touch');pointer('pointerdown',400,100,2,'touch');
    pointer('pointermove',450,100,2,'touch');expect(viewport.getFrame()!.xToLogical(325)).toBeCloseTo(anchor,10);
    expect(viewport.getRange()!.to-viewport.getRange()!.from).toBeCloseTo(48);
    pointer('pointerup',450,100,2,'touch');const before=viewport.getRange()!;
    pointer('pointermove',220,100,1,'touch');expect(viewport.getRange()!.from).toBeLessThan(before.from);
    expect(viewport.getFrame()!.series.candles).toEqual(candles());
  });
  it.each(['pointercancel','lostpointercapture'])('%s ends gesture and prevents stale movement',event=>{
    pointer('pointerdown',200,100);pointer(event,200,100);const before=viewport.getRange();pointer('pointermove',400,100);expect(viewport.getRange()).toEqual(before);
  });
  it('prepended history rebases an active drag without ending it',()=>{
    const spacing=viewport.getFrame()!.spacing;pointer('pointerdown',200,100);viewport.setCandles(candles(-20,220));const before=viewport.getRange()!;
    pointer('pointermove',200+spacing*3,100);expect(viewport.getRange()!.from).toBeCloseTo(before.from-3);expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
  });
  it('keyboard owns only the focused canvas and keeps bounds/ARX Home-End convention',()=>{
    const input=document.createElement('input');container.append(input);input.focus();const before=viewport.getRange();key('ArrowLeft',input);expect(viewport.getRange()).toEqual(before);
    canvas.focus();key('ArrowLeft');expect(viewport.getRange()!.from).toBe(28);key('+');expect(viewport.getRange()!.to-viewport.getRange()!.from).toBe(48);
    const current=viewport.getRange();expect(key('ArrowRight',canvas,{ctrlKey:true}).defaultPrevented).toBe(false);expect(viewport.getRange()).toEqual(current);
    key('Home');expect(viewport.getRange()!.from).toBeLessThanOrEqual(0);expect(viewport.getRange()!.to).toBeGreaterThanOrEqual(199);
    key('End');expect(viewport.getState().followingLatest).toBe(true);
    for(let i=0;i<100;i++)key('ArrowLeft');expect(viewport.getRange()!.from).toBeGreaterThanOrEqual(-3);
  });
  it('ignores queued input and commands after destruction',()=>{
    const before=viewport.getState().paintCount;viewport.destroy();pointer('pointerdown',100,100);wheel(100,100,-20);key('End');viewport.setCandles(candles());viewport.resize(800,400);viewport.goLatest();viewport.fit();flush();
    expect(viewport.getState()).toMatchObject({status:'destroyed',paintCount:before});expect(viewport.exportImage()).toBeNull();
  });
});

it('initial zero size has no default300x150 backing and can later become visible',()=>{
  width=height=0;create();expect(canvas.width).toBe(0);expect(canvas.height).toBe(0);expect(viewport.getFrame()).toBeNull();
  width=800;height=400;viewport.resize();flush();expect(viewport.getState().status).toBe('ready');
});
it('editable canvas and secondary pointer buttons do not steal input',()=>{
  create();viewport.setRange({from:40,to:100});canvas.focus();canvas.setAttribute('contenteditable','true');const before=viewport.getRange();
  expect(key('ArrowLeft').defaultPrevented).toBe(false);expect(viewport.getRange()).toEqual(before);
  const e=new MouseEvent('pointerdown',{clientX:210,clientY:120,button:2,cancelable:true});Object.defineProperties(e,{pointerId:{value:1},pointerType:{value:'pen'}});canvas.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(false);pointer('pointermove',400,100);expect(viewport.getRange()).toEqual(before);
});
it('a callback destroying during hover withdrawal cannot restart resize or source ownership',()=>{
  create({onCrosshair:value=>{if(value===null)viewport.destroy();}});pointer('pointermove',200,100);const widthBefore=canvas.width;
  viewport.resize(700,300);expect(viewport.getState().status).toBe('destroyed');expect(canvas.width).toBe(widthBefore);expect(queue.size).toBe(0);
});

it.each(['prices','append','rolling'])('active drag survives same-context %s refresh',kind=>{
  create();viewport.setRange({from:40,to:100});const spacing=viewport.getFrame()!.spacing;
  pointer('pointerdown',200,100);pointer('pointermove',200+spacing*2,100);
  const refreshed=kind==='append'?candles(0,201):kind==='rolling'?candles(1,200):candles();refreshed[refreshed.length-1]!.close+=.25;
  viewport.setCandles(refreshed);const before=viewport.getRange()!;pointer('pointermove',200+spacing*5,100);
  expect(viewport.getRange()!.from).toBeCloseTo(before.from-3);expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
});
it('active pinch survives a refreshed OHLC window and prepend with the same anchor under its fingers',()=>{
  create();viewport.setRange({from:40,to:100});pointer('pointerdown',200,100,1,'touch');pointer('pointerdown',400,100,2,'touch');
  pointer('pointermove',450,100,2,'touch');const anchor=viewport.getFrame()!.xToLogical(325)!;
  const next=candles(-20,220);next[next.length-1]!.close+=.25;viewport.setCandles(next);
  expect(viewport.getFrame()!.xToLogical(325)).toBeCloseTo(anchor+20);
  pointer('pointermove',500,100,2,'touch');expect(viewport.getFrame()!.xToLogical(350)).toBeCloseTo(anchor+20);
  expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
});
it('disjoint same-context history explicitly cancels an unanchorable gesture',()=>{
  create();pointer('pointerdown',200,100);viewport.setCandles(candles(500,200));const before=viewport.getRange();pointer('pointermove',400,100);expect(viewport.getRange()).toEqual(before);expect(canvas.releasePointerCapture).toHaveBeenCalled();
});
it.each(['reset','replace','range','style'])('reentrant %s during hover withdrawal wins over an older data mutation',action=>{
  let armed=false;create({onCrosshair:value=>{if(value!==null||!armed)return;armed=false;
    if(action==='reset')viewport.resetContext();if(action==='replace')viewport.setCandles(candles(500,100));if(action==='range')viewport.setRange({from:10,to:30});if(action==='style')viewport.setStyle('line');
  }});
  pointer('pointermove',200,100);armed=true;viewport.setCandles(candles(500,201));
  if(action==='reset')expect(viewport.getState().barCount).toBe(0);
  if(action==='replace')expect(viewport.getFrame()!.series.candles[0]!.time).toBe(candles(500,100)[0]!.time);
  if(action==='range')expect(viewport.getRange()).toEqual({from:10,to:30});
  if(action==='style')expect(viewport.getState().style).toBe('line');
  if(action==='range'||action==='style')expect(viewport.getState().barCount).toBe(200);
});

function outsidePointer(type:string,x:number,y:number,id=1) {
  const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x+10,clientY:y+20,button:0});
  Object.defineProperty(event,'pointerId',{value:id});document.body.dispatchEvent(event);return event;
}
it('capture failure still moves and releases only the owned pointer outside the canvas',()=>{
  create();viewport.setRange({from:40,to:100});canvas.setPointerCapture=vi.fn(()=>{throw Error('capture unavailable');});
  const spacing=viewport.getFrame()!.spacing;pointer('pointerdown',200,100);const before=viewport.getRange()!;
  expect(outsidePointer('pointermove',200+spacing*3,100,99).defaultPrevented).toBe(false);expect(viewport.getRange()).toEqual(before);
  outsidePointer('pointermove',200+spacing*3,100);expect(viewport.getRange()!.from).toBeCloseTo(before.from-3);
  outsidePointer('pointerup',200+spacing*3,100);const released=viewport.getRange();pointer('pointermove',400,100);expect(viewport.getRange()).toEqual(released);
});
it.each(['pointercancel','blur'])('outside %s clears captured gestures and never revives them',type=>{
  create();viewport.setRange({from:40,to:100});pointer('pointerdown',200,100);
  if(type==='blur')window.dispatchEvent(new Event('blur'));else outsidePointer(type,200,100);
  const before=viewport.getRange();pointer('pointermove',400,100);expect(viewport.getRange()).toEqual(before);
  viewport.destroy();outsidePointer('pointermove',500,100);window.dispatchEvent(new Event('blur'));flush();expect(queue.size).toBe(0);
});


describe('native viewport source clock qualification',()=>{
 it('defaults to source time, revokes completed proof on qualification changes, and does not loop for unchanged evidence',()=>{
  create({timeZone:'America/New_York'});expect(viewport.getState()).toMatchObject({utcClockQualified:false,effectiveTimeZone:'UTC'});expect(ctx.fillText.mock.calls.some((a:any[])=>String(a[0]).includes('source'))).toBe(true);
  viewport.setSourceClockQualified(true);expect(viewport.isAnalysisFocusVerified()).toBe(false);ctx.fillText.mockClear();flush();expect(viewport.getState()).toMatchObject({utcClockQualified:true,effectiveTimeZone:'America/New_York'});expect(ctx.fillText.mock.calls.some((a:any[])=>/EST|EDT/.test(String(a[0])))).toBe(true);
  const paints=viewport.getState().paintCount;viewport.setSourceClockQualified(true);expect(queue.size).toBe(0);expect(viewport.getState().paintCount).toBe(paints);
  viewport.setSourceClockQualified(false);expect(viewport.isAnalysisFocusVerified()).toBe(false);ctx.fillText.mockClear();expect(viewport.exportImage()).toBe('data:image/png;base64,fixture');expect(ctx.fillText.mock.calls.some((a:any[])=>String(a[0]).includes('source'))).toBe(true);expect(viewport.getState().effectiveTimeZone).toBe('UTC');
 });
 it('reset withdraws qualification and same-candle UTC preference cannot preserve it',()=>{
  create();viewport.setSourceClockQualified(true);flush();viewport.setSourceClockQualified(false);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.getState().utcClockQualified).toBe(false);
  viewport.setSourceClockQualified(true);flush();viewport.resetContext();viewport.setCandles(candles());ctx.fillText.mockClear();flush();expect(viewport.getState().utcClockQualified).toBe(false);expect(ctx.fillText.mock.calls.some((a:any[])=>String(a[0]).includes('source'))).toBe(true);
  viewport.setSourceClockQualified('true' as unknown as boolean);expect(viewport.getState().utcClockQualified).toBe(false);expect(queue.size).toBe(0);
 });
 it('qualified daily views retain existing UTC convention without granting unqualified conversion',()=>{
  create({timeZone:'America/New_York',timeframe:'D1'});viewport.setSourceClockQualified(true);flush();expect(viewport.getState()).toMatchObject({utcClockQualified:true,effectiveTimeZone:'UTC'});
 });
});


describe('native viewport retained caller height',()=>{
 it('keeps a changed explicit height through ResizeObserver, window resize, and DPR changes',()=>{
  create({height:520});viewport.resize(undefined,360);flush();expect(viewport.getState().height).toBe(360);
  width=390;observers[0]!.callback([],{} as ResizeObserver);flush();expect(viewport.getState()).toMatchObject({width:390,height:360});
  window.dispatchEvent(new Event('resize'));flush();expect(viewport.getState().height).toBe(360);
  vi.stubGlobal('devicePixelRatio',3);media.at(-1)!.callback?.({});flush();expect(viewport.getState()).toMatchObject({height:360,pixelRatio:3});expect(canvas.height).toBe(1080);
 });
 it('retains explicit height even when equal to current geometry, but unconfigured charts still measure container height',()=>{
  create();height=450;observers[0]!.callback([],{} as ResizeObserver);expect(viewport.getState().height).toBe(450);
  viewport.resize(undefined,450);height=600;observers[0]!.callback([],{} as ResizeObserver);expect(viewport.getState().height).toBe(450);
 });
 it('retains explicit zero until a valid caller height replaces it',()=>{
  create({height:520});viewport.resize(undefined,0);observers[0]!.callback([],{} as ResizeObserver);expect(viewport.getState()).toMatchObject({height:0,status:'unavailable'});
  viewport.resize(undefined,300);observers[0]!.callback([],{} as ResizeObserver);expect(viewport.getState().height).toBe(300);
 });
 it('a reentrant resize supersedes the old pending height, including later observer calls',()=>{
  let armed=false;create({height:520,onCrosshair:row=>{if(!row&&armed){armed=false;viewport.resize(undefined,280);}}});pointer('pointermove',200,100);armed=true;viewport.resize(undefined,360);expect(viewport.getState().height).toBe(280);
  observers[0]!.callback([],{} as ResizeObserver);expect(viewport.getState().height).toBe(280);
 });
});

it('sizes automatic canvas geometry to the host content box, not its border and padding',()=>{
  container.style.border='1px solid black';container.style.padding='8px 12px';
  create();
  expect(viewport.getState()).toMatchObject({width:774,height:382});
  expect(canvas.style.width).toBe('774px');expect(canvas.style.height).toBe('382px');
  // Repeated observation of unchanged layout must not republish a new paint.
  const paints=viewport.getState().paintCount;
  for(let i=0;i<8;i++){observers[0]!.callback([],{} as ResizeObserver);flush();}
  expect(viewport.getState().paintCount).toBe(paints);
});
it('border-box min-content observation cannot grow the canvas on every observer delivery',()=>{
  container.style.border='1px solid black';create();
  const original=viewport.getState().width;
  // Layout feedback model: auto grid min-content is canvas width plus the
  // host's actual two border pixels. Real browser acceptance owns CSS layout.
  for(let i=0;i<24;i++){
    width=parseFloat(canvas.style.width)+2;
    observers[0]!.callback([],{} as ResizeObserver);flush();
  }
  expect(viewport.getState().width).toBe(original);
  expect(width).toBe(800);
});
it('automatic dimensions retain fractional content space while explicit plot dimensions stay exact',()=>{
  width=390.5;height=260.5;container.style.border='1px solid black';create({height:260});
  expect(viewport.getState()).toMatchObject({width:388.5,height:260});
  viewport.resize(300,240);expect(viewport.getState()).toMatchObject({width:300,height:240});
  width=250.25;observers[0]!.callback([],{} as ResizeObserver);
  expect(viewport.getState()).toMatchObject({width:248.25,height:240});
});

it('uses the canvas content origin for pointer evidence in a bordered padded host',()=>{
  container.style.border='1px solid black';container.style.padding='8px 12px';
  const onCrosshair=vi.fn();create({onCrosshair});const state=viewport.getState();
  vi.spyOn(canvas,'getBoundingClientRect').mockReturnValue({x:23,y:29,left:23,top:29,right:23+state.width,bottom:29+state.height,width:state.width,height:state.height,toJSON(){}});
  const frame=viewport.getFrame()!,x=frame.plot.left+frame.plot.width/2,y=frame.plot.top+frame.plot.height/2;
  const event=new MouseEvent('pointermove',{bubbles:true,clientX:23+x,clientY:29+y});
  Object.defineProperties(event,{pointerId:{value:1},pointerType:{value:'mouse'}});canvas.dispatchEvent(event);
  expect(onCrosshair).toHaveBeenLastCalledWith(expect.objectContaining({candle:frame.barAtX(x),price:frame.yToPrice(y)}));
});
it('changes interval visibility and pane layout without changing the history or calculated values',()=>{
 create();viewport.setStudies([{kind:'rsi',id:'r',period:2,color:'#ffffff',visibleIntervals:['H1']}]);flush();
 const range=viewport.getRange(),time=candles().at(-1)!.time,value=viewport.getStudyValues(time)[0]!.values[0]!.value;
 expect(viewport.getPaneLayout()!.panes).toHaveLength(0);
 viewport.setDisplayTimeZone('UTC','H1');flush();expect(viewport.getPaneLayout()!.panes).toHaveLength(1);
 expect(viewport.getStudyValues(time)[0]!.values[0]).toEqual({name:'RSI',value});expect(viewport.getRange()).toEqual(range);
 viewport.setDisplayTimeZone('UTC','M15');flush();expect(viewport.getPaneLayout()!.panes).toHaveLength(0);
 expect(viewport.getStudyValues(time)[0]!.values[0]).toEqual({name:'RSI (hidden)',value});expect(viewport.getRange()).toEqual(range);
});
it('retains selected candle and geometry when only the Data Window preference changes',()=>{
 const onCrosshair=vi.fn();create({onCrosshair});const study={kind:'rsi' as const,id:'r',period:2,color:'#ffffff'};
 viewport.setStudies([study]);flush();pointer('pointermove',300,100);flush();
 const hover=onCrosshair.mock.calls.at(-1)![0];expect(hover).not.toBeNull();onCrosshair.mockClear();
 const layout=viewport.getPaneLayout(),range=viewport.getRange();
 viewport.setStudies([{...study,showInDataWindow:false}]);flush();
 expect(onCrosshair.mock.calls.some(([value])=>value===null)).toBe(false);
 expect(viewport.getPaneLayout()).toEqual(layout);expect(viewport.getRange()).toEqual(range);
 expect(viewport.getStudyValues(hover.candle.time)[0]!.dataWindowVisible).toBe(false);
});

describe('explicit pinned candle inspection',()=>{
 it('keeps the selected timestamp across pointer leave and refresh, updates corrected values, and withdraws removed bars',()=>{
  const onCrosshair=vi.fn();create({onCrosshair});pointer('pointermove',250,120);
  const time=onCrosshair.mock.calls.at(-1)![0].candle.time;
  expect(viewport.inspectCandle('pin')).toBe(true);pointer('pointerleave',250,120);pointer('pointermove',500,160);flush();
  expect(viewport.getState()).toMatchObject({inspectionPinned:true,inspectionTime:time});
  const data=candles();data.find(c=>c.time===time)!.close+=.5;viewport.setCandles(data);flush();
  expect(onCrosshair.mock.calls.at(-1)![0].candle.close).toBe(data.find(c=>c.time===time)!.close);
  expect(viewport.getState().inspectionPinned).toBe(true);
  viewport.setCandles(data.filter(c=>c.time!==time));flush();
  expect(onCrosshair).toHaveBeenLastCalledWith(null);expect(viewport.getState().inspectionPinned).toBe(false);
 });
 it('navigates actual loaded bars with gaps and scrolls them into view without changing OHLC',()=>{
  create();const data=candles().filter((_,i)=>i%3!==0);viewport.setCandles(data);viewport.setRange({from:50,to:70});flush();
  const original=structuredClone(viewport.getCandles());
  expect(viewport.inspectCandle('first')).toBe(true);flush();expect(viewport.getState().inspectionTime).toBe(data[0]!.time);
  expect(viewport.inspectCandle('previous')).toBe(false);expect(viewport.inspectCandle('next')).toBe(true);flush();
  expect(viewport.getState().inspectionTime).toBe(data[1]!.time);
  expect(viewport.inspectCandle('last')).toBe(true);flush();expect(viewport.getState().inspectionTime).toBe(data.at(-1)!.time);
  expect(viewport.getFrame()!.timeToX(data.at(-1)!.time)).toBeLessThanOrEqual(viewport.getFrame()!.plot.left+viewport.getFrame()!.plot.width);
  expect(viewport.getCandles()).toEqual(original);expect(viewport.inspectCandle('next')).toBe(false);
 });
 it('uses focused Shift+arrows for inspection, keeps plain arrows for panning, and Escape releases',()=>{
  create();canvas.focus();expect(key('ArrowLeft',canvas,{shiftKey:true}).defaultPrevented).toBe(true);flush();
  const time=viewport.getState().inspectionTime!;expect(viewport.getState().inspectionPinned).toBe(true);
  key('ArrowLeft',canvas,{shiftKey:true});flush();expect(viewport.getState().inspectionTime).toBe(time-60);
  key('Escape');flush();expect(viewport.getState().inspectionPinned).toBe(false);
  const range=viewport.getRange();key('ArrowLeft');flush();expect(viewport.getRange()).not.toEqual(range);
  const input=document.createElement('input');container.append(input);input.focus();key('ArrowRight',input,{shiftKey:true});expect(viewport.getState().inspectionPinned).toBe(false);
 });
 it('withdraws pins on context reset, timeframe change and linked inspection takeover',()=>{
  create();viewport.inspectCandle('pin');viewport.resetContext();flush();expect(viewport.getState().inspectionPinned).toBe(false);
  viewport.setCandles(candles());viewport.inspectCandle('pin');viewport.setDisplayTimeZone('UTC','M15');flush();expect(viewport.getState().inspectionPinned).toBe(false);
  viewport.inspectCandle('pin');viewport.setLinkedCrosshair(candles()[30]!.time);flush();expect(viewport.getState().inspectionPinned).toBe(false);
 });
});

it('a reentrant context reset during pin publication supersedes the old selection and range event',()=>{
 const range=vi.fn();create({onCrosshair:value=>{if(value)viewport.resetContext();},onUserRangeChange:range});
 expect(viewport.inspectCandle('first')).toBe(false);flush();
 expect(viewport.getState()).toMatchObject({inspectionPinned:false,inspectionTime:null,barCount:0});expect(range).not.toHaveBeenCalled();
});
it('pinned bars stay anchored when newer bars arrive and ordinary Escape is not consumed',()=>{
 create();canvas.focus();expect(key('Escape').defaultPrevented).toBe(false);
 viewport.inspectCandle('previous');flush();const before=viewport.getRange(),time=viewport.getState().inspectionTime;
 viewport.setCandles(candles(0,220));flush();expect(viewport.getRange()).toEqual(before);expect(viewport.getState().inspectionTime).toBe(time);
});

it('applies saved pane weights to actual viewport geometry without changing canonical observations',()=>{
 create();const rsi={kind:'rsi' as const,period:14,color:'#ffffff'},macd={kind:'macd' as const,period:12,slow:26,signal:9,color:'#ff0000'};
 viewport.setStudies([rsi,macd]);flush();const before=viewport.getPaneLayout()!,data=viewport.getCandles();
 viewport.setStudies([{...rsi,paneWeight:3},macd]);flush();const after=viewport.getPaneLayout()!;
 expect(after.panes[0]!.height).toBeGreaterThan(before.panes[0]!.height);expect(after.panes[1]!.height).toBeGreaterThanOrEqual(40);expect(after.price.height).toBeGreaterThanOrEqual(100);
 expect(viewport.getCandles()).toBe(data);expect(viewport.getState().status).toBe('ready');
});

it('collapses complete panes, preserves observations and restores the previous geometry',()=>{
 create();const rsi={id:'rsi',kind:'rsi' as const,period:14,color:'#ffffff',paneWeight:3},macd={kind:'macd' as const,period:12,slow:26,signal:9,color:'#ff0000'};
 viewport.setStudies([rsi,macd]);flush();const before=viewport.getPaneLayout()!,data=viewport.getCandles(),range=viewport.getRange();
 viewport.setStudies([{...rsi,paneCollapsed:true},macd]);flush();
 expect(viewport.getPaneLayout()!.panes[0]!.height).toBe(24);expect(viewport.getPaneLayout()!.price.height).toBeGreaterThan(before.price.height);
 expect(viewport.getCandles()).toBe(data);expect(viewport.getRange()).toEqual(range);expect(viewport.getState().status).toBe('ready');
 viewport.setStudies([{...rsi,paneCollapsed:false},macd]);flush();expect(viewport.getPaneLayout()).toEqual(before);
});

it('preserves a pinned historical candle across independent status-line preference changes',()=>{
 create();const study={kind:'rsi' as const,id:'r',period:2,color:'#ffffff'};viewport.setStudies([study]);flush();
 viewport.inspectCandle('first');viewport.inspectCandle('next');flush();const before=viewport.getState(),layout=viewport.getPaneLayout();
 for(const showInStatusLine of [true,false]){viewport.setStudies([{...study,showInStatusLine}]);flush();expect(viewport.getState().inspectionPinned).toBe(true);expect(viewport.getState().inspectionTime).toBe(before.inspectionTime);expect(viewport.getPaneLayout()).toEqual(layout);}
});

it('scale label controls preserve pins and withdraw painted labels in simplified mode',()=>{
 create();const study={kind:'sma' as const,id:'s',period:2,color:'#abcdef'};viewport.setStudies([study]);flush();
 viewport.inspectCandle('previous');flush();const before=viewport.getState(),layout=viewport.getPaneLayout();
 ctx.fillText.mockClear();viewport.setStudies([{...study,showOnScale:true}]);flush();
 expect(viewport.getState().inspectionTime).toBe(before.inspectionTime);expect(viewport.getState().inspectionPinned).toBe(true);expect(viewport.getPaneLayout()).toEqual(layout);
 expect(ctx.fillText.mock.calls.some((a:any[])=>a[0]==='300.5')).toBe(true);
 ctx.fillText.mockClear();viewport.setAnalysisFocus(true);flush();expect(ctx.fillText.mock.calls.some((a:any[])=>a[0]==='300.5')).toBe(false);
 ctx.fillText.mockClear();viewport.setAnalysisFocus(false);viewport.setStudies([study]);flush();expect(ctx.fillText.mock.calls.some((a:any[])=>a[0]==='300.5')).toBe(false);
});
