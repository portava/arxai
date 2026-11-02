import { createElement } from 'react';
import {ChartWorkbenchTools} from '../../components/charts/ChartWorkbenchTools';
import {DEFAULT_PREFERENCES} from './chartWorkspace';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartPaneControls } from '../../components/charts/ChartPaneControls';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NativeChartsAdapter} from './nativeChartsAdapter';
import {NativeChartViewport} from './nativeChartViewport';
import {ChartViewLink} from './chartViewLink';
import {CHART_STYLES} from './chartWorkspace';
import type {ChartEngineCandle} from './types';
const bars=(start=0,count=200):ChartEngineCandle[]=>Array.from({length:count},(_,i)=>({time:1700000000+(start+i)*60,open:100+start+i,high:103+start+i,low:99+start+i,close:102+start+i}));
let queue:Map<number,FrameRequestCallback>,next:number,ctx:any,adapters:NativeChartsAdapter[],containers:HTMLElement[];
function flush(){for(let i=0;i<8&&queue.size;i++){const callbacks=[...queue.values()];queue.clear();for(const cb of callbacks)cb(1);}expect(queue.size).toBe(0);}
function setup(){const adapter=new NativeChartsAdapter(),container=document.createElement('div');document.body.append(container);containers.push(container);adapters.push(adapter);adapter.init({container,height:400,visibleDesktop:40,visibleMobile:20});return{adapter,container,viewport:()=>((adapter as any).viewport as NativeChartViewport),canvas:()=>container.querySelector('canvas')!};}
function pointer(canvas:HTMLCanvasElement,x:number,y:number){const e=new MouseEvent('pointermove',{bubbles:true,cancelable:true,clientX:x,clientY:y});Object.defineProperties(e,{pointerId:{value:1},pointerType:{value:'mouse'}});canvas.dispatchEvent(e);}
beforeEach(()=>{queue=new Map();next=1;adapters=[];containers=[];ctx=new Proxy({measureText:vi.fn((text:string)=>({width:text.length*6}))}as any,{get:(target,key)=>{if(!(key in target))target[key]=vi.fn();return target[key];},set:(target,key,value)=>{target[key]=value;return true;}});vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(ctx);vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/png;base64,fixture');vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){const width=this instanceof HTMLCanvasElement?parseFloat(this.style.width):800,height=this instanceof HTMLCanvasElement?parseFloat(this.style.height):400;return{x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON(){}};});vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{const id=next++;queue.set(id,cb);return id;});vi.stubGlobal('cancelAnimationFrame',(id:number)=>queue.delete(id));vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});vi.stubGlobal('matchMedia',()=>({addEventListener(){},removeEventListener(){}}));vi.stubGlobal('devicePixelRatio',1);vi.stubGlobal('innerWidth',1200);});
afterEach(()=>{cleanup();adapters.forEach(a=>a.destroy());containers.forEach(c=>c.remove());vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('native ChartEngineAdapter contract',()=>{
 it('keeps source clock qualification independent per chart and revokes it on context reset',()=>{
  const a=setup(),b=setup();a.adapter.setCandles(bars());b.adapter.setCandles(bars());
  a.adapter.setDisplayTimeZone('America/New_York');b.adapter.setDisplayTimeZone('America/New_York');flush();
  expect(a.viewport().getState().utcClockQualified).toBe(false);
  expect(a.viewport().getState().effectiveTimeZone).toBe('UTC');
  const before=a.viewport().getCandles();a.adapter.setSourceClockQualified(true);
  expect(a.adapter.isAnalysisFocusVerified()).toBe(false);flush();
  expect(a.viewport().getState().effectiveTimeZone).toBe('America/New_York');
  expect(b.viewport().getState().utcClockQualified).toBe(false);
  a.adapter.setSourceClockQualified(false);expect(a.adapter.isAnalysisFocusVerified()).toBe(false);flush();
  expect(a.viewport().getState().effectiveTimeZone).toBe('UTC');expect(a.viewport().getCandles()).toEqual(before);
  a.adapter.setSourceClockQualified(true);a.adapter.resetDataContext();a.adapter.setCandles(bars());flush();
  expect(a.viewport().getState().utcClockQualified).toBe(false);
 });
 it('constructor is side-effect-free and init/destroy own one canvas',()=>{const a=new NativeChartsAdapter();expect(queue.size).toBe(0);expect(a.capabilities).toMatchObject({id:'arx-native',draggableOrders:false});const f=setup();expect(f.container.querySelectorAll('canvas')).toHaveLength(1);f.adapter.init({container:f.container,height:300});expect(f.container.querySelectorAll('canvas')).toHaveLength(1);f.adapter.destroy();f.adapter.destroy();expect(f.container.querySelector('canvas')).toBeNull();expect(f.adapter.exportImage()).toBeNull();flush();});
 it('sanitizes immutable canonical candles and returns only actual visible rows',()=>{const f=setup(),data=bars();f.adapter.setCandles([...data,{...data[3]!,high:NaN}]);flush();expect(f.viewport().getCandles()).toHaveLength(200);data.at(-1)!.close=999;const visible=f.adapter.getVisibleCandles();expect(visible.at(-1)!.close).toBe(301);visible.at(-1)!.close=998;expect(f.adapter.getVisibleCandles().at(-1)!.close).toBe(301);expect(visible.length).toBeLessThan(200);});
 it('preserves zoom/pan timestamp anchors after prepended history',()=>{const f=setup();f.adapter.setCandles(bars(100,200));f.adapter.panBy(-.5);flush();const before=f.adapter.getVisibleCandles().map(c=>c.time);f.adapter.setCandles(bars(0,300));flush();expect(f.adapter.getVisibleCandles().map(c=>c.time)).toEqual(before);});
 it('retains same-source streamed tip only until history catches up or source changes',()=>{const f=setup();f.adapter.setFeedState({livePriceAffordance:true,source:'A'});f.adapter.setCandles(bars());f.adapter.updateActiveCandle(bars(200,1)[0]!);f.adapter.setCandles(bars());expect(f.viewport().getCandles()).toHaveLength(201);f.adapter.setFeedState({livePriceAffordance:false,source:'B'});f.adapter.setCandles(bars());expect(f.viewport().getCandles()).toHaveLength(200);f.adapter.updateActiveCandle({...bars(199,1)[0]!,close:300});f.adapter.setCandles(bars());expect(f.viewport().getCandles().at(-1)!.close).toBe(301);});
 it('rejects old/invalid updates and never promotes missing streamed volume evidence',()=>{const f=setup();const data=bars();data.at(-1)!.volumeEvidence={kind:'tick_count',quantity:12,unit:'ticks',reason:null};f.adapter.setCandles(data);f.adapter.setStudies([{kind:'tick_volume',period:1,color:'#38bdf8'}]);f.adapter.updateActiveCandle({...data[3]!,close:102});f.adapter.updateActiveCandle({...data.at(-1)!,high:NaN});expect(f.adapter.getStudyValues(data.at(-1)!.time)[0]!.values[0]!.value).toBe(12);f.adapter.updateActiveCandle(bars(199,1)[0]!);expect(f.adapter.getStudyValues(data.at(-1)!.time)[0]!.values[0]!.value).toBeNull();});
 it('replay revealLatest follows shrinking/expanding data without resurrecting future bars',()=>{const f=setup();f.adapter.setCandles(bars());f.adapter.panBy(-1);f.adapter.setCandles(bars(0,50),{revealLatest:true});flush();expect(f.adapter.getVisibleCandles().at(-1)!.time).toBe(bars(49,1)[0]!.time);expect(f.viewport().getCandles()).toHaveLength(50);f.adapter.setCandles(bars(0,70),{revealLatest:true});flush();expect(f.adapter.getVisibleCandles().at(-1)!.time).toBe(bars(69,1)[0]!.time);});
 for(const style of CHART_STYLES)it(`delegates ${style} without changing canonical studies`,()=>{const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{kind:'sma',period:3,color:'#38bdf8'}]);const time=bars().at(-1)!.time,values=f.adapter.getStudyValues(time);f.adapter.setChartStyle(style);f.adapter.setScaleMode('log');f.adapter.setPriceScaleInverted(true);flush();expect(f.adapter.getStudyValues(time)).toEqual(values);expect(f.viewport().getState().status).toBe('ready');expect(f.adapter.getDisplayCandle(time)!==null).toBe(style==='heikinAshi');expect(f.adapter.exportImage()).toBe('data:image/png;base64,fixture');});
 it('supports fit/reset/recent/go-to history honestly and rejects malformed navigation',()=>{const f=setup();f.adapter.setCandles(bars());f.adapter.fitHistory();flush();expect(f.adapter.getVisibleCandles()).toHaveLength(200);f.adapter.resetScale();flush();expect(f.adapter.getVisibleCandles().length).toBeLessThan(200);expect(f.adapter.goToTime(1)).toBe(false);expect(f.adapter.panBy(Infinity)).toBe(false);expect(f.adapter.zoomBy(0)).toBe(false);expect(f.adapter.showRecentRange(-1)).toBeNull();expect(f.adapter.showRecentRange(600)).toEqual({complete:true});expect(f.adapter.showRecentRange(86400)).toEqual({complete:false});expect(f.adapter.goToTime(bars(50,1)[0]!.time)).toBe(true);flush();expect(f.adapter.getVisibleCandles().some(c=>c.time===bars(50,1)[0]!.time)).toBe(true);});
 it('reset scale also restores vertical automatic fitting through the existing viewport',()=>{
  const f=setup();f.adapter.setCandles(bars());flush();const reset=vi.fn();Object.assign(f.viewport(),{resetPriceScale:reset});
  f.adapter.resetScale();flush();expect(reset).toHaveBeenCalledOnce();expect(f.adapter.getVisibleCandles().length).toBeLessThan(200);
 });
 it('a reentrant reset during vertical restoration cannot navigate the replacement context',()=>{
  const f=setup();f.adapter.setCandles(bars());flush();const viewport=f.viewport(),setRange=vi.spyOn(viewport,'setRange');
  const reset=vi.fn(()=>f.adapter.resetDataContext());Object.assign(viewport,{resetPriceScale:reset});
  f.adapter.resetScale();flush();expect(reset).toHaveBeenCalledOnce();expect(setRange).not.toHaveBeenCalled();expect(f.adapter.getVisibleCandles()).toEqual([]);
 });
 it('shares linked UTC ranges and own close crosshair without feedback',()=>{const a=setup(),b=setup();a.adapter.setCandles(bars());b.adapter.setCandles(bars().map(c=>({...c,open:c.open+1000,high:c.high+1000,low:c.low+1000,close:c.close+1000})));a.adapter.setTimeframe('M1');b.adapter.setTimeframe('M1');flush();const cross=vi.fn();b.adapter.setCrosshairHandler(cross);const links=new ChartViewLink();links.configure({crosshair:true,range:true});const offA=links.register('a',a.adapter),offB=links.register('b',b.adapter);a.adapter.panBy(-.5);flush();expect(b.adapter.getVisibleCandles().map(c=>c.time)).toEqual(a.adapter.getVisibleCandles().map(c=>c.time));const frame=a.viewport().getFrame()!,bar=a.adapter.getVisibleCandles()[5]!;pointer(a.canvas(),frame.timeToX(bar.time)!,frame.priceToY(bar.close)!);flush();expect(cross).toHaveBeenLastCalledWith(expect.objectContaining({time:bar.time,close:bar.close+1000}));offA();offB();});
 it('linked cursor never invents candles in session gaps and timezone never changes its UTC input',()=>{const f=setup(),data=[...bars(0,30),...bars(100,30)],handler=vi.fn(),link=vi.fn();f.adapter.setCandles(data);f.adapter.setTimeframe('M1');f.adapter.setCrosshairHandler(handler);f.adapter.setViewLinkHandler(link);f.adapter.setDisplayTimeZone('America/New_York');f.adapter.setLinkedCrosshair(bars(50,1)[0]!.time);flush();expect(handler).toHaveBeenLastCalledWith(null);expect(link).not.toHaveBeenCalled();f.adapter.setLinkedCrosshair(data.at(-1)!.time+30);flush();expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({time:data.at(-1)!.time}));expect(link).not.toHaveBeenCalled();});
 it('reports linked unloaded history and reapplies it after data arrives',()=>{const f=setup(),status=vi.fn(),link=vi.fn();f.adapter.setViewLinkStatusHandler(status);f.adapter.setViewLinkHandler(link);const range={from:bars(20,1)[0]!.time,to:bars(30,1)[0]!.time};f.adapter.setLinkedTimeRange(range);expect(status).toHaveBeenLastCalledWith('Linked time range is waiting for candles.');f.adapter.setCandles(bars());flush();expect(f.adapter.getVisibleCandles().map(c=>c.time)).toEqual(bars(20,11).map(c=>c.time));expect(link).not.toHaveBeenCalled();});
 it('coalesces viewport notifications and supports cleanup/reentrant reset',()=>{const f=setup(),listener=vi.fn(),reach=vi.fn();f.adapter.setCandles(bars());flush();const off=f.adapter.subscribeViewport(listener);f.adapter.setReachStartHandler(reach,25);f.adapter.fitHistory();f.adapter.zoomBy(.9);flush();expect(listener).toHaveBeenCalledTimes(1);expect(reach).toHaveBeenCalled();off();f.adapter.panBy(.2);flush();expect(listener).toHaveBeenCalledTimes(1);const second=vi.fn();let reset=false;f.adapter.subscribeViewport(()=>{if(!reset){reset=true;f.adapter.resetDataContext();}});f.adapter.subscribeViewport(()=>{if(f.viewport().getCandles().length)second();});f.adapter.panBy(.2);flush();expect(second).not.toHaveBeenCalled();expect(f.adapter.getVisibleCandles()).toEqual([]);});
 it('reset revokes scanner/drawing/context data but retains selected study configuration',()=>{const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{kind:'sma',period:3,color:'#38bdf8'}]);const surface=f.adapter.getScannerOverlaySurface()!;surface.createPriceLine({price:250,color:'#ffffff',title:'Old',axisLabelVisible:true,lineWidth:1,lineStyle:'solid'});f.adapter.setDrawings([{id:'old',kind:'horizontal',start:{time:bars()[0]!.time,price:250},color:'#ffffff'}]);f.adapter.resetDataContext();flush();expect(surface.priceToCoordinate(250)).toBeNull();expect(f.viewport().getDrawings()).toEqual([]);expect(f.adapter.getVisibleCandles()).toEqual([]);f.adapter.setCandles(bars());flush();expect(f.adapter.getStudyValues(bars().at(-1)!.time)).toHaveLength(1);});
 it('a callback destroying the adapter cannot notify later subscribers or stale handlers',()=>{const f=setup();f.adapter.setCandles(bars());flush();const later=vi.fn(),link=vi.fn();f.adapter.setViewLinkHandler(link);f.adapter.setCrosshairHandler(()=>f.adapter.destroy());f.adapter.subscribeViewport(later);const p=f.viewport().getFrame()!,bar=f.adapter.getVisibleCandles()[1]!;pointer(f.canvas(),p.timeToX(bar.time)!,p.priceToY(bar.close)!);flush();expect(later).not.toHaveBeenCalled();expect(link).not.toHaveBeenCalled();});
 it('incoming linked range cannot echo a programmatic clearing of an active local hover',()=>{
  const f=setup(),link=vi.fn();f.adapter.setCandles(bars());f.adapter.setViewLinkHandler(link);flush();const p=f.viewport().getFrame()!,bar=f.adapter.getVisibleCandles()[3]!;pointer(f.canvas(),p.timeToX(bar.time)!,p.priceToY(bar.close)!);flush();link.mockClear();f.adapter.setLinkedTimeRange({from:bars(50,1)[0]!.time,to:bars(70,1)[0]!.time});flush();expect(link).not.toHaveBeenCalled();
 });
 it('volume profile and exact VWAP anchor labels withdraw on metadata-only source change',()=>{
  const f=setup(),authority='twelve-data:time-series:common-stock:regular-unadjusted:v1',identity='a'.repeat(64);
  const data:ChartEngineCandle[]=bars(0,30).map((b,i)=>({...b,volumeEvidence:{kind:'real_volume',unit:'provider_trade_units',quantity:100+i,reason:null,authority,seriesIdentity:identity},profileEvidence:{finality:'closed',clockAuthority:authority}}));
  const anchor={kind:'observed_bar' as const,time:data[0]!.time,seriesIdentity:identity};f.adapter.setCandles(data);f.adapter.setStudies([{kind:'volume_profile',period:1,color:'#aaaaaa',profileRows:8,profileRange:{kind:'observed_range',fromTime:data[0]!.time,toTime:data.at(-1)!.time,seriesIdentity:identity,clockAuthority:authority}},{kind:'vwap',period:1,color:'#aaaaaa',vwapAnchor:anchor}]);
  expect(f.adapter.getVolumeProfiles()[0]!.result.status).toBe('ready');expect(f.adapter.getVwapAnchorEvidence(anchor).utcQualified).toBe(true);expect(f.adapter.getStudyValues(data[0]!.time)[1]!.displayLabel).not.toContain('unverified');
  f.adapter.setChartStyle('heikinAshi');expect(f.adapter.getVolumeProfiles()[0]!.result.status).toBe('ready');f.adapter.setCandles(data.map(bar=>({...bar,profileEvidence:{finality:'closed',clockAuthority:null}})));expect(f.adapter.getVolumeProfiles()[0]!.result.status).toBe('held');expect(f.adapter.getVwapAnchorEvidence(anchor).utcQualified).toBe(false);expect(f.adapter.getStudyValues(data[0]!.time)[1]!.displayLabel).toContain('unverified');
 });
 it('live price is withdrawn immediately and not granted by ticks or rendering style',()=>{
  const f=setup();f.adapter.setCandles(bars());expect(f.viewport().getState().livePriceAffordance).toBe(false);f.adapter.setFeedState({livePriceAffordance:true,source:'A'});expect(f.viewport().getState().livePriceAffordance).toBe(true);f.adapter.setFeedState({livePriceAffordance:false,source:'A'});f.adapter.updateActiveCandle(bars(200,1)[0]!);f.adapter.setChartStyle('heikinAshi');flush();expect(f.viewport().getState().livePriceAffordance).toBe(false);f.adapter.resetDataContext();expect(f.viewport().getState().livePriceAffordance).toBe(false);
 });

 it.each([['EURUSD',5],['USDJPY',3]] as const)('preserves existing %s minimum price display precision', (symbol,digits)=>{
  const f=setup(),data=bars(0,30).map(c=>({...c,open:1.10,high:1.12,low:1.09,close:1.11}));f.adapter.setSymbol(symbol);f.adapter.setCandles(data);expect(f.viewport().getPricePrecision()).toBe(digits);f.adapter.updateActiveCandle({...data.at(-1)!,close:1.10});expect(f.viewport().getPricePrecision()).toBe(digits);
 });
 it('changing symbol updates existing display precision without changing canonical prices',()=>{
  const f=setup(),data=bars(0,30).map(c=>({...c,open:1.10,high:1.12,low:1.09,close:1.11}));f.adapter.setCandles(data);expect(f.viewport().getPricePrecision()).toBe(2);f.adapter.setSymbol('EURUSD');expect(f.viewport().getPricePrecision()).toBe(5);expect(f.viewport().getCandles()).toEqual(data);
 });

 it('initial legend and unhovered ticks report latest canonical candle, but explicit linked absence stays null',()=>{
  const f=setup(),handler=vi.fn();f.adapter.setCrosshairHandler(handler);f.adapter.setCandles(bars());flush();expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({time:bars().at(-1)!.time}));f.adapter.updateActiveCandle(bars(200,1)[0]!);flush();expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({time:bars(200,1)[0]!.time}));f.adapter.setLinkedCrosshair(null);flush();expect(handler).toHaveBeenLastCalledWith(null);f.adapter.updateActiveCandle(bars(201,1)[0]!);flush();expect(handler).toHaveBeenLastCalledWith(null);
 });
 it('an explicit replay prefix cannot retain a future streamed tip',()=>{
  const f=setup();f.adapter.setCandles(bars());f.adapter.updateActiveCandle(bars(200,1)[0]!);f.adapter.setCandles(bars(0,50),{revealLatest:true});flush();expect(f.viewport().getCandles()).toHaveLength(50);expect(f.adapter.getVisibleCandles().at(-1)!.time).toBe(bars(49,1)[0]!.time);
 });

 it('discloses a linked range expanded by the existing minimum navigation span',()=>{const f=setup(),status=vi.fn();f.adapter.setCandles(bars());f.adapter.setViewLinkStatusHandler(status);f.adapter.setLinkedTimeRange({from:bars(50,1)[0]!.time,to:bars(50,1)[0]!.time+30});flush();expect(status).toHaveBeenLastCalledWith('Linked time range is adjusted to this view’s loaded history and navigation limits.');});

 it('a linked follower near loaded-history start does not request independent deep history',()=>{
  const f=setup(),reach=vi.fn();f.adapter.setCandles(bars());flush();f.adapter.setReachStartHandler(reach,20);
  f.adapter.setLinkedTimeRange({from:bars(2,1)[0]!.time,to:bars(12,1)[0]!.time});flush();expect(reach).not.toHaveBeenCalled();
  f.adapter.panBy(-.1);flush();expect(reach).toHaveBeenCalledOnce();
 });
 it.each(['refresh','trimmed refresh','context reset'] as const)('%s cannot publish a synthetic user crosshair-clear to linked peers',mode=>{
  const f=setup(),events=vi.fn();f.adapter.setCandles(bars());f.adapter.setViewLinkHandler(events);flush();
  const frame=f.viewport().getFrame()!,bar=f.adapter.getVisibleCandles()[3]!;pointer(f.canvas(),frame.timeToX(bar.time)!,frame.priceToY(bar.close)!);flush();
  expect(events).toHaveBeenLastCalledWith({kind:'crosshair',time:bar.time});events.mockClear();
  if(mode==='refresh')f.adapter.setCandles(bars(0,201));else if(mode==='trimmed refresh')f.adapter.setCandles(bars(180,40));else f.adapter.resetDataContext();
  flush();expect(events).not.toHaveBeenCalled();
  if(mode==='context reset')expect(f.adapter.getVisibleCandles()).toEqual([]);
 });
 it('replay backward seeks recalculate studies and HA only from the revealed prefix',()=>{
  const f=setup(),reference=setup(),all=bars(0,220);f.adapter.setStudies([{kind:'sma',period:3,color:'#38bdf8'}]);reference.adapter.setStudies([{kind:'sma',period:3,color:'#38bdf8'}]);
  f.adapter.setChartStyle('heikinAshi');reference.adapter.setChartStyle('heikinAshi');
  f.adapter.setCandles(all,{revealLatest:true});f.adapter.setCandles(all.slice(0,30),{revealLatest:true});reference.adapter.setCandles(all.slice(0,30),{revealLatest:true});flush();
  expect(f.adapter.getStudyValues(all[29]!.time)).toEqual(reference.adapter.getStudyValues(all[29]!.time));
  expect(f.adapter.getDisplayCandle(all[29]!.time)).toEqual(reference.adapter.getDisplayCandle(all[29]!.time));
  expect(f.adapter.getDisplayCandle(all[30]!.time)).toBeNull();expect(f.adapter.getStudyValues(all[30]!.time).flatMap(row=>row.values).every(value=>value.value===null)).toBe(true);
  f.adapter.setCandles(all.slice(0,1),{revealLatest:true});flush();expect(f.adapter.getVisibleCandles()).toEqual(all.slice(0,1));expect(f.adapter.getStudyValues(all[0]!.time)[0]!.values[0]!.value).toBeNull();
 });
 it('a comparison arriving late maps the last linked UTC range to its own interval and prices',()=>{
  const a=setup(),b=setup(),links=new ChartViewLink();a.adapter.setTimeframe('M1');a.adapter.setCandles(bars());flush();
  links.configure({crosshair:true,range:true});const offA=links.register('primary',a.adapter);a.adapter.showRecentRange(1800);flush();
  const own=bars().filter((_,i)=>i%5===0).map(c=>({...c,open:c.open+500,high:c.high+500,low:c.low+500,close:c.close+500}));
  b.adapter.setTimeframe('M5');const status=vi.fn();b.adapter.setViewLinkStatusHandler(status);const offB=links.register('comparison',b.adapter);
  expect(status).toHaveBeenLastCalledWith('Linked time range is waiting for candles.');b.adapter.setCandles(own);flush();
  expect(b.adapter.getVisibleCandles().every(c=>own.some(o=>o.time===c.time&&o.close===c.close))).toBe(true);
  const handler=vi.fn();b.adapter.setCrosshairHandler(handler);b.adapter.setLinkedCrosshair(bars(172,1)[0]!.time);flush();expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({time:bars(170,1)[0]!.time,close:bars(170,1)[0]!.close+500}));
  offA();offB();
 });

 it('time-axis drag publishes real loaded time range once and programmatic prepend does not echo a new user range',()=>{
  const f=setup(),events=vi.fn();f.adapter.setCandles(bars(100,200));f.adapter.panBy(-.5);flush();f.adapter.setViewLinkHandler(events);f.adapter.panBy(-.1);flush();events.mockClear();
  const frame=f.viewport().getFrame()!,layout=f.viewport().getPaneLayout()!,last=layout.panes.at(-1)??layout.price,x=frame.plot.left+frame.plot.width*.4,y=last.top+last.height+14,source=f.viewport().getCandles();
  const send=(kind:string,xx:number)=>{const e=new MouseEvent(kind,{bubbles:true,cancelable:true,clientX:xx,clientY:y,button:0});Object.defineProperties(e,{pointerId:{value:1},pointerType:{value:'mouse'}});f.canvas().dispatchEvent(e);};
  const span=frame.range.to-frame.range.from;send('pointerdown',x);send('pointermove',x+100);send('pointerup',x+100);flush();expect(f.viewport().getRange()!.to-f.viewport().getRange()!.from).toBeLessThan(span);expect(f.viewport().getCandles()).toBe(source);
  const ranges=events.mock.calls.map(([e])=>e).filter(e=>e.kind==='range');expect(ranges).toHaveLength(1);expect(source.some(b=>b.time===ranges[0]!.range.from)).toBe(true);expect(source.some(b=>b.time===ranges[0]!.range.to)).toBe(true);
  events.mockClear();f.adapter.setCandles(bars(0,300));flush();expect(events).not.toHaveBeenCalled();
 });

});

it('publishes pinned corrected evidence through the adapter and clears it on context replacement',()=>{
 const a=setup(),handler=vi.fn();a.adapter.setCrosshairHandler(handler);a.adapter.setCandles(bars());flush();
 expect(a.adapter.inspectCandle('previous')).toBe(true);flush();const selected=handler.mock.calls.at(-1)![0];
 expect(a.adapter.isCandleInspectionPinned()).toBe(true);
 const data=bars();data.find(c=>c.time===selected.time)!.close+=.5;a.adapter.setCandles(data);flush();
 expect(handler.mock.calls.at(-1)![0]).toMatchObject({time:selected.time,close:selected.close+.5});
 a.adapter.resetDataContext();flush();expect(a.adapter.isCandleInspectionPinned()).toBe(false);expect(handler).toHaveBeenLastCalledWith(null);
 a.adapter.setCandles(bars(400));flush();expect(handler.mock.calls.at(-1)![0].time).not.toBe(selected.time);
});

it('publishes pane controls only for current painted native owners and withdraws on reset',()=>{
 const f=setup();f.adapter.setCandles(bars());const rsi={id:'rsi',kind:'rsi' as const,period:14,color:'#ffffff',paneCollapsed:true,visibleIntervals:[]};
 f.adapter.setStudies([{id:'linked',kind:'sma',period:3,color:'#00ff00',studySource:{studyId:'rsi',channel:0}},rsi]);
 expect(f.adapter.getStudyPaneControls()).toBeNull();flush();
 const controls=f.adapter.getStudyPaneControls()!;expect(controls).toHaveLength(1);expect(controls[0]).toMatchObject({id:'rsi',paneIndex:1,collapsed:true,height:24});
 const layout=f.viewport().getPaneLayout()!.panes[0]!;expect(controls[0]!.top).toBe(layout.top);expect(controls[0]!.left).toBe(layout.left);expect(controls[0]!.width).toBe(layout.width);
 controls[0]!.top=999;expect(f.adapter.getStudyPaneControls()![0]!.top).toBe(layout.top);
 f.adapter.setAnalysisFocus(true);expect(f.adapter.getStudyPaneControls()).toEqual([]);flush();expect(f.adapter.getStudyPaneControls()).toEqual([]);
 f.adapter.setAnalysisFocus(false);flush();expect(f.adapter.getStudyPaneControls()).toHaveLength(1);
 f.adapter.resetDataContext();expect(f.adapter.getStudyPaneControls()).toEqual([]);flush();expect(f.adapter.getStudyPaneControls()).toEqual([]);
 f.adapter.destroy();expect(f.adapter.getStudyPaneControls()).toEqual([]);
});

it('retains focused direct pane controls across real pre-paint hover notifications',()=>{
 const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'}]);flush();
 render(createElement(ChartPaneControls,{adapter:f.adapter,chartTarget:{current:f.container as HTMLDivElement},enabled:true,onPreferences:vi.fn()}));
 const button=screen.getByRole('button',{name:/Collapse pane 1:/});button.focus();
 pointer(f.canvas(),300,100);
 // Real adapter crosshair notification runs before the pending canvas paint.
 const first=[...queue.entries()][0]!;queue.delete(first[0]);act(()=>first[1](1));
 expect(document.activeElement).toBe(button);expect(screen.getByRole('button',{name:/Collapse pane 1:/})).toBe(button);
 act(()=>flush());expect(document.activeElement).toBe(button);
});

it('previews pane resizing without changing saved studies or values, then restores on cancellation',()=>{
 const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'},{id:'macd',kind:'macd',period:12,color:'#00ff00'}]);flush();
 const geometry=f.viewport().getPaneLayout(),studies=f.viewport().getStudies(),values=bars().map(b=>f.adapter.getStudyValues(b.time));
 const token=f.adapter.beginStudyPaneResize('rsi')!;expect(token).not.toBeNull();expect(f.adapter.previewStudyPaneResize(token,20)).toBe(true);flush();
 expect(f.viewport().getPaneLayout()!.price.height).toBeCloseTo(geometry!.price.height+20,8);
 expect(f.viewport().getStudies()).toEqual(studies);expect(bars().map(b=>f.adapter.getStudyValues(b.time))).toEqual(values);
 expect(f.adapter.endStudyPaneResize(token,false)).toBeNull();flush();expect(f.viewport().getPaneLayout()).toEqual(geometry);
});
it('commits only current resize leases and rejects changed source, dimensions or study context',()=>{
 const f=setup();const install=()=>{f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'}]);flush();};install();
 let token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.previewStudyPaneResize(token,20);const result=f.adapter.endStudyPaneResize(token,true)!;
 expect(result.weights.rsi).toBeLessThan(1);expect(f.adapter.isStudyPaneResizeContextCurrent(result.contextKey)).toBe(true);flush();
 token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.previewStudyPaneResize(token,-20);f.adapter.resetDataContext();install();
 expect(f.adapter.endStudyPaneResize(token,true)).toBeNull();expect(f.adapter.isStudyPaneResizeContextCurrent(result.contextKey)).toBe(false);
 token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.resize(800,450);expect(f.adapter.previewStudyPaneResize(token,10)).toBe(false);flush();
 token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.setStudies([{id:'rsi',kind:'rsi',period:21,color:'#ffffff'}]);expect(f.adapter.endStudyPaneResize(token,true)).toBeNull();flush();
 const fresh=f.adapter.beginStudyPaneResize('rsi')!;expect(f.adapter.previewStudyPaneResize(token,20)).toBe(false);expect(f.adapter.endStudyPaneResize(fresh,false)).toBeNull();
});

it('a resize context round trip never revives a prior lease or completed commit',()=>{
 const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'}]);flush();
 const token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.previewStudyPaneResize(token,20);f.adapter.resize(800,450);f.adapter.resize(800,400);flush();expect(f.adapter.endStudyPaneResize(token,true)).toBeNull();flush();
 const second=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.previewStudyPaneResize(second,10);const result=f.adapter.endStudyPaneResize(second,true)!;
 f.adapter.setChartStyle('line');f.adapter.setChartStyle('candles');expect(f.adapter.isStudyPaneResizeContextCurrent(result.contextKey)).toBe(false);
});
it('canvas and divider pointers cannot own chart gestures simultaneously',()=>{
 const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'}]);flush();
 const down=()=>{const event=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:200,clientY:100});Object.defineProperties(event,{pointerId:{value:7},pointerType:{value:'touch'}});f.canvas().dispatchEvent(event);return event;};
 down();flush();expect(f.adapter.beginStudyPaneResize('rsi')).toBeNull();
 f.canvas().dispatchEvent(new Event('pointercancel'));flush();const token=f.adapter.beginStudyPaneResize('rsi')!;expect(token).not.toBeNull();expect(down().defaultPrevented).toBe(true);f.adapter.endStudyPaneResize(token,false);
});

it('ordinary candle updates preserve a divider preview but remount cannot reuse its lease',()=>{
 const f=setup(),install=()=>{f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'}]);flush();};install();
 const token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.previewStudyPaneResize(token,15);
 f.adapter.updateActiveCandle({...bars().at(-1)!,close:301.5});flush();expect(f.viewport().getCandles().at(-1)!.close).toBe(301.5);expect(f.adapter.previewStudyPaneResize(token,20)).toBe(true);
 const result=f.adapter.endStudyPaneResize(token,true)!;flush();
 f.adapter.init({container:f.container,height:400});install();const next=f.adapter.beginStudyPaneResize('rsi')!;
 expect(next).not.toBe(token);expect(f.adapter.isStudyPaneResizeContextCurrent(result.contextKey)).toBe(false);expect(f.adapter.endStudyPaneResize(token,false)).toBeNull();expect(f.adapter.previewStudyPaneResize(next,10)).toBe(true);f.adapter.endStudyPaneResize(next,false);
});

it.each(['placement','navigation'])('retiring preview through %s restores frame and completed paint',kind=>{
 const f=setup();f.adapter.setCandles(bars());f.adapter.setStudies([{id:'rsi',kind:'rsi',period:14,color:'#ffffff'}]);flush();
 const original=f.viewport().getFrame()!.plot,token=f.adapter.beginStudyPaneResize('rsi')!;f.adapter.previewStudyPaneResize(token,20);flush();expect(f.viewport().getFrame()!.plot.height).toBeCloseTo(original.height+20,8);
 if(kind==='placement')f.adapter.setDrawingHandler(()=>{});else f.adapter.setNavigationMode('pan');
 expect(f.adapter.isAnalysisFocusVerified()).toBe(false);flush();expect(f.viewport().getFrame()!.plot).toEqual(original);expect(f.adapter.isAnalysisFocusVerified()).toBe(true);expect(f.adapter.endStudyPaneResize(token,true)).toBeNull();
});

it.each(['maximized','simplified','pan','hidden'] as const)('settles real native paint and toolbar verification in %s mode',mode=>{
 const f=setup();const studies=[{id:'rsi',kind:'rsi' as const,period:14,color:'#ffffff'}];f.adapter.setCandles(bars());f.adapter.setStudies(studies);flush();
 if(mode==='maximized')f.adapter.setMaximizedStudyPane('rsi');
 if(mode==='simplified')f.adapter.setAnalysisFocus(true);
 flush();render(createElement(ChartWorkbenchTools,{adapter:f.adapter,epoch:1,symbol:'EURUSD',timeframe:'M15',preferences:{...DEFAULT_PREFERENCES,studies},onPreferences:vi.fn(),hasCandles:true,feedLabel:'Offline',analysisFocused:mode==='simplified',maximizedPane:mode==='maximized'?'rsi':null}));
 if(mode==='pan'){fireEvent.click(screen.getByRole('button',{name:'Pan',exact:true}));expect(f.container.dataset.chartNavigation).toBe('pan');}
 if(mode==='hidden'){fireEvent.click(screen.getByRole('button',{name:'Objects (0)',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Hide drawings',exact:true}));expect(screen.getByRole('button',{name:'Show drawings',exact:true})).toBeTruthy();}
 for(let i=0;i<20;i++)act(()=>{const batch=[...queue.values()];queue.clear();batch.forEach(cb=>cb(i));});
 expect(queue.size).toBe(0);expect(f.adapter.isAnalysisFocusVerified()).toBe(true);expect(screen.queryByLabelText('Saved studies (visibility unverified)')).toBeNull();
 const count=f.viewport().getState().paintCount;for(let i=0;i<5;i++)act(()=>{const batch=[...queue.values()];queue.clear();batch.forEach(cb=>cb(i));});expect(f.viewport().getState().paintCount).toBe(count);
});
it('does not request another paint when disabled drawing interaction clears an already empty selection',()=>{
 const f=setup();f.adapter.setCandles(bars());flush();f.adapter.setAnalysisFocus(true);flush();
 f.adapter.setDrawingInteraction(null);expect(queue.size).toBe(0);
});

it('identifies latest fallback, exact historical pin and unavailable readout timestamps',()=>{
 const f=setup(),data=bars();f.adapter.setCandles(data);flush();
 expect(f.adapter.getCandleReadoutOrigin(data.at(-1)!.time)).toBe('latest');expect(f.adapter.getCandleReadoutOrigin(data[0]!.time)).toBe('unavailable');
 f.adapter.inspectCandle('first');flush();const time=f.viewport().getState().inspectionTime!;expect(f.adapter.getCandleReadoutOrigin(time)).toBe('pinned');
 f.adapter.inspectCandle('clear');pointer(f.canvas(),300,100);flush();expect(f.adapter.getCandleReadoutOrigin(f.viewport().getState().inspectionTime!)).toBe('pointer');
 f.adapter.setLinkedCrosshair(data[100]!.time);flush();expect(f.adapter.getCandleReadoutOrigin(data[100]!.time)).toBe('linked');
 f.adapter.setLinkedCrosshair(null);flush();expect(f.adapter.getCandleReadoutOrigin(data.at(-1)!.time)).toBe('unavailable');
 f.adapter.resetDataContext();flush();expect(f.adapter.getCandleReadoutOrigin(time)).toBe('unavailable');
 f.adapter.setCandles(data);flush();expect(f.adapter.getCandleReadoutOrigin(data.at(-1)!.time)).toBe('latest');
});
