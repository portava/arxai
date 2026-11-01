import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
const state=vi.hoisted(()=>({engines:[] as any[], engineId:'arx-native', initError:false, direct:vi.fn()}));
vi.mock('@/lib/chart-engine',()=>({createChartEngineAdapter:()=>{
 let surface:any;
 const engine:any={verified:true,listeners:new Set<()=>void>(),retired:[] as Array<()=>void>,isAnalysisFocusVerified:vi.fn(()=>engine.verified),subscribeViewport:vi.fn((listener:()=>void)=>{engine.listeners.add(listener);engine.retired.push(listener);return()=>engine.listeners.delete(listener);}),capabilities:{id:state.engineId},init:vi.fn(()=>{if(state.initError)throw new Error('Unavailable');}),destroy:vi.fn(),resize:vi.fn(),setSymbol:vi.fn(),setSourceClockQualified:vi.fn(),setFeedState:vi.fn(),setCandles:vi.fn(),resetDataContext:vi.fn(()=>surface?.dispose()),fitHistory:vi.fn(),setOverlays:vi.fn(),setStructureLines:vi.fn(),getScannerOverlaySurface:vi.fn(()=>{
  if(!surface||surface.disposed){surface={disposed:false,lines:[] as any[],createPriceLine:vi.fn((line:any)=>{const handle={dispose:vi.fn()};surface.lines.push({line,handle});return handle;}),createMarkers:vi.fn(),dispose:vi.fn(()=>{surface.disposed=true;})};engine.surfaces.push(surface);}return surface;
 }),surfaces:[] as any[]};state.engines.push(engine);return engine;
}}));
// A regression to direct library construction must be detected, not fail on a
// jsdom Canvas limitation before reaching the contract assertion.
vi.mock('lightweight-charts',()=>({createChart:state.direct,CandlestickSeries:{},createSeriesMarkers:vi.fn(),ColorType:{Solid:0},LineStyle:{Dashed:1,Solid:0},CrosshairMode:{Normal:0}}));
import {PositionMiniChart,type PositionMiniChartProps} from './PositionMiniChart';
const bars=[{time:1700000000000,open:100,high:110,low:90,close:105},{time:1700000900000,open:105,high:115,low:100,close:110}];
const base:PositionMiniChartProps={symbol:'EURUSD',side:'BUY',entryPrice:103,currentPrice:111,stopLoss:95,takeProfit:114,candles:bars};
const ro:Array<{callback:ResizeObserverCallback,disconnect:ReturnType<typeof vi.fn>}>=[];
beforeEach(()=>{state.engines=[];state.engineId='arx-native';state.initError=false;ro.length=0;state.direct.mockReset().mockImplementation(()=>({addSeries:()=>({setData:vi.fn(),createPriceLine:vi.fn()}),timeScale:()=>({fitContent:vi.fn()}),applyOptions:vi.fn(),remove:vi.fn()}));vi.stubGlobal('ResizeObserver',class{entry:any;constructor(callback:ResizeObserverCallback){this.entry={callback,disconnect:vi.fn()};ro.push(this.entry);}observe(){}disconnect(){this.entry.disconnect();}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const lines=()=>state.engines[0]!.surfaces.at(-1)?.lines.map((row:any)=>row.line)??[];
describe('position preview shared renderer',()=>{
 it('uses the selected shared engine, unknown source clock, no fabricated entry marker and read-only surface',()=>{
  render(<PositionMiniChart {...base}/>);expect(state.engines).toHaveLength(1);expect(state.direct).not.toHaveBeenCalled();
  const e=state.engines[0]!;expect(e.setSourceClockQualified).toHaveBeenLastCalledWith(false);expect(e.setFeedState).toHaveBeenLastCalledWith({livePriceAffordance:false,source:null});
  expect(e.setCandles).toHaveBeenLastCalledWith(bars.map(b=>({...b,time:Math.floor(b.time/1000)})));expect(e.surfaces.at(-1).createMarkers).not.toHaveBeenCalled();
  expect(screen.getByTestId('position-mini-chart').hasAttribute('inert')).toBe(true);expect(screen.getByRole('img').getAttribute('aria-label')).toContain('EURUSD');
  expect(screen.getByTestId('chart-native-credit')).toBeTruthy();expect(screen.queryByTestId('chart-library-credit')).toBeNull();
  expect(lines().map((line:any)=>line.title)).toEqual(['Entry · BUY','SL','TP']);
 });
 it('retains actual library attribution for a selected Lightweight Charts engine',()=>{state.engineId='lightweight-charts';render(<PositionMiniChart {...base}/>);expect(state.engines).toHaveLength(1);expect(screen.getByTestId('chart-library-credit')).toBeTruthy();expect(screen.queryByTestId('chart-native-credit')).toBeNull();});
 it('retains the renderer across monetary/history/height refresh and disposes superseded overlays',()=>{
  const view=render(<PositionMiniChart {...base} displayStatus="LIVE"/>);expect(state.engines).toHaveLength(1);const e=state.engines[0]!,old=e.surfaces.at(-1);
  view.rerender(<PositionMiniChart {...base} currentPrice={112} stopLoss={96} candles={[...bars,{...bars[1]!,time:1700001800000}]} height={250} displayStatus="LIVE"/>);
  expect(state.engines).toHaveLength(1);expect(e.destroy).not.toHaveBeenCalled();expect(old.dispose).toHaveBeenCalledOnce();expect(e.resize).toHaveBeenLastCalledWith(undefined,250);
  expect(lines().find((line:any)=>line.title==='Current')?.price).toBe(112);expect(lines().find((line:any)=>line.title==='SL')?.price).toBe(96);
 });
 it.each(['ANALYSIS_ONLY','STALE','FALLBACK_COMPOSITE','UNAVAILABLE'] as const)('withdraws Current and native last-price permission on %s',status=>{
  const view=render(<PositionMiniChart {...base} displayStatus="LIVE"/>);expect(state.engines).toHaveLength(1);expect(lines().some((line:any)=>line.title==='Current')).toBe(true);
  view.rerender(<PositionMiniChart {...base} displayStatus={status}/>);expect(lines().some((line:any)=>line.title==='Current')).toBe(false);expect(state.engines[0].setFeedState).toHaveBeenLastCalledWith({livePriceAffordance:false,source:null});
 });
 it('rejects nonfinite/nonpositive overlays and clears empty or malformed history',()=>{
  const view=render(<PositionMiniChart {...base} entryPrice={NaN} stopLoss={0} takeProfit={Infinity} currentPrice={-1} displayStatus="LIVE"/>);expect(state.engines).toHaveLength(1);expect(lines()).toEqual([]);
  view.rerender(<PositionMiniChart {...base} candles={[{...bars[0]!,high:NaN}]}/>);expect(screen.getByTestId('position-mini-chart-empty')).toBeTruthy();expect(state.engines[0].destroy).toHaveBeenCalledOnce();expect(screen.queryByTestId('chart-native-credit')).toBeNull();
 });
 it('rebinds symbol on retained renderer with old context and overlays withdrawn',()=>{
  const view=render(<PositionMiniChart {...base}/>);expect(state.engines).toHaveLength(1);const e=state.engines[0]!,before=e.resetDataContext.mock.calls.length,old=e.surfaces.at(-1);
  view.rerender(<PositionMiniChart {...base} symbol="USDJPY" candles={bars.map(b=>({...b,open:150,high:152,low:149,close:151}))}/>);
  expect(state.engines).toHaveLength(1);expect(e.resetDataContext).toHaveBeenCalledTimes(before+1);expect(old.dispose).toHaveBeenCalled();expect(e.setSymbol).toHaveBeenLastCalledWith('USDJPY');expect(e.setSourceClockQualified).toHaveBeenLastCalledWith(false);
 });
 it('ignores retained resize callbacks after unmount',()=>{const view=render(<PositionMiniChart {...base}/>);expect(state.engines).toHaveLength(1);const e=state.engines[0]!,late=ro[0]!;view.unmount();const count=e.resize.mock.calls.length;expect(()=>late.callback([],{} as ResizeObserver)).not.toThrow();expect(e.resize).toHaveBeenCalledTimes(count);expect(late.disconnect).toHaveBeenCalledOnce();expect(e.destroy).toHaveBeenCalledOnce();});
 it('contains an initialization failure and releases the partial renderer',()=>{state.initError=true;render(<PositionMiniChart {...base}/>);expect(screen.getByTestId('position-mini-chart-empty')).toBeTruthy();expect(state.engines[0].destroy).toHaveBeenCalledOnce();expect(screen.queryByTestId('chart-native-credit')).toBeNull();});
 it('does not construct an empty chart and can start when valid bars arrive',()=>{const view=render(<PositionMiniChart {...base} candles={[]}/>);expect(state.engines).toHaveLength(0);view.rerender(<PositionMiniChart {...base}/>);expect(state.engines).toHaveLength(1);expect(screen.queryByTestId('position-mini-chart-empty')).toBeNull();});
 it('reports unverified paint without making recovery permanent and ignores retired proof callbacks',()=>{
  const view=render(<PositionMiniChart {...base}/>);const e=state.engines[0]!;
  expect(screen.queryByTestId('position-mini-chart-paint-status')).toBeNull();
  act(()=>{e.verified=false;for(const callback of e.listeners)callback();});expect(screen.getByTestId('position-mini-chart-paint-status').textContent).toContain('not yet verified');
  act(()=>{e.verified=true;for(const callback of e.listeners)callback();});expect(screen.queryByTestId('position-mini-chart-paint-status')).toBeNull();expect(state.engines).toHaveLength(1);
  view.unmount();expect(e.listeners.size).toBe(0);const reads=e.isAnalysisFocusVerified.mock.calls.length;act(()=>{for(const callback of e.retired)callback();});expect(e.isAnalysisFocusVerified).toHaveBeenCalledTimes(reads);
 });

});
