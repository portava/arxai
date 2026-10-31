import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ChartWorkbenchTools} from './ChartWorkbenchTools';
import {DEFAULT_PREFERENCES} from '@/lib/chart-engine/chartWorkspace';
import type {ChartEngineAdapter} from '@/lib/chart-engine';

let callback: ResizeObserverCallback;
const observe=vi.fn(),disconnect=vi.fn();
beforeEach(()=>{
 localStorage.clear();vi.clearAllMocks();
 vi.stubGlobal('ResizeObserver',class{constructor(cb:ResizeObserverCallback){callback=cb;}observe=observe;disconnect=disconnect;});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const mount=()=>render(<ChartWorkbenchTools adapter={{setNavigationMode:vi.fn(),panBy:vi.fn()} as unknown as ChartEngineAdapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES} onPreferences={vi.fn()} hasCandles feedLabel="Offline fixture"/>);
const resize=(width:number)=>act(()=>callback([{contentRect:{width}} as ResizeObserverEntry],{} as ResizeObserver));
const tools=()=>screen.getByTestId('chart-advanced-tools');

it('starts a narrow viewport collapsed without first laying out the expanded toolbar',()=>{
 vi.stubGlobal('innerWidth',390);mount();
 expect(tools().className).toBe('hidden');
 resize(900);expect(tools().className).toBe('contents');
});
it('does not force a synchronous toolbar layout when mounting or opening tools',()=>{
 const reads=vi.spyOn(HTMLElement.prototype,'clientWidth','get');mount();
 expect(reads).not.toHaveBeenCalled();expect(observe).toHaveBeenCalledTimes(1);
 resize(360);fireEvent.click(screen.getByRole('button',{name:'Chart tools'}));
 expect(reads).not.toHaveBeenCalled();expect(observe).toHaveBeenCalledTimes(1);
});
it('uses each pane content width and the exact breakpoint',()=>{
 mount();resize(639);expect(tools().className).toBe('hidden');
 resize(640);expect(tools().className).toBe('contents');
 resize(320);expect(tools().className).toBe('hidden');
 for(const width of [0,-1,NaN,Infinity]){resize(width);expect(tools().className).toBe('hidden');}
});
it('moves focus before responsive hiding and returns it to Pan when widening',()=>{
 mount();resize(900);screen.getByLabelText('Price scale').focus();
 resize(360);const toggle=screen.getByRole('button',{name:'Chart tools'});
 expect(document.activeElement).toBe(toggle);expect(tools().className).toBe('hidden');
 resize(900);expect(document.activeElement).toBe(screen.getByRole('button',{name:'Pan',exact:true}));
});
it('preserves open tools and their keyboard focus through narrow/wide changes',()=>{
 mount();resize(360);fireEvent.click(screen.getByRole('button',{name:'Chart tools'}));
 const scale=screen.getByLabelText('Price scale');scale.focus();
 resize(900);resize(360);expect(document.activeElement).toBe(scale);expect(tools().className).toBe('contents');
 fireEvent.click(screen.getByRole('button',{name:'Chart tools'}));
 expect(tools().className).toBe('hidden');
});
it('disconnects once and ignores late deliveries after unmount',()=>{
 const view=mount();resize(360);view.unmount();expect(disconnect).toHaveBeenCalledTimes(1);
 expect(()=>resize(900)).not.toThrow();
});
