// Preserve the late ResizeObserver regression at the shared-adapter boundary.
// The renderer is retained through polling; disposal still races queued resize.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
const state=vi.hoisted(()=>({engines:[] as any[],callbacks:[] as ResizeObserverCallback[]}));
vi.mock('@/lib/chart-engine',()=>({createChartEngineAdapter:()=>{
 const e:any={removed:false,capabilities:{id:'lightweight-charts'},init:vi.fn(),destroy:vi.fn(()=>{e.removed=true;}),resize:vi.fn(()=>{if(e.removed)throw new Error('Object is disposed');}),setCandles:vi.fn(),setFeedState:vi.fn(),setSymbol:vi.fn(),setSourceClockQualified:vi.fn(),resetDataContext:vi.fn(),fitHistory:vi.fn(),getScannerOverlaySurface:()=>({createPriceLine:vi.fn(),dispose:vi.fn()})};state.engines.push(e);return e;
}}));
import {PositionMiniChart} from './PositionMiniChart';
const props={symbol:'Volatility 75 Index',side:'BUY' as const,entryPrice:1.2,currentPrice:1.4,stopLoss:.9,takeProfit:2.1,candles:[{time:1700000000000,open:1,high:2,low:.5,close:1.5},{time:1700000900000,open:1.5,high:2.5,low:1,close:2}]};
beforeEach(()=>{state.engines=[];state.callbacks=[];vi.stubGlobal('ResizeObserver',class{constructor(cb:ResizeObserverCallback){state.callbacks.push(cb);}observe(){}disconnect(){}});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('PositionMiniChart ResizeObserver disposal race',()=>{
 it('retains plain library credit only when the shared engine actually selects it',()=>{
  const view=render(<PositionMiniChart {...props}/>),credit=view.getByTestId('chart-library-credit');
  expect(credit.querySelector('svg,img,canvas')).toBeNull();expect(view.getByRole('link',{name:'TradingView Lightweight Charts™'}).getAttribute('href')).toBe('https://www.tradingview.com/');
 });
 it('ignores a callback delivered after teardown before reaching the disposed renderer',()=>{
  const view=render(<PositionMiniChart {...props}/>),e=state.engines[0]!,late=state.callbacks[0]!;view.unmount();const count=e.resize.mock.calls.length;
  expect(e.destroy).toHaveBeenCalledOnce();expect(()=>late([],{} as ResizeObserver)).not.toThrow();expect(e.resize).toHaveBeenCalledTimes(count);
 });
 it('still sizes the mounted renderer',()=>{render(<PositionMiniChart {...props}/>);state.callbacks[0]!([],{} as ResizeObserver);expect(state.engines[0].resize).toHaveBeenLastCalledWith(expect.any(Number));});
 it('contains a disposed-renderer error during the resize callback',()=>{render(<PositionMiniChart {...props}/>);state.engines[0].removed=true;expect(()=>state.callbacks[0]!([],{} as ResizeObserver)).not.toThrow();});
});
