import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
const seen=vi.hoisted(()=>[] as any[]);
vi.mock('./PositionMiniChart',()=>({PositionMiniChart:(props:any)=>{seen.push(props);return <output data-testid="mini-props">{JSON.stringify(props)}</output>;}}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:vi.fn()})}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
vi.mock('@/lib/use-chart-symbol',()=>({setChartSymbol:vi.fn()}));
import {PositionSideCard,type UnifiedPosition} from './PositionSideCard';
const position=(symbol:string):UnifiedPosition=>({scope:'live',brokerTicket:'synthetic',symbol,side:'BUY',lotSize:1,entryPrice:100,currentPrice:101,stopLoss:90,takeProfit:120,floatingPnl:1,openedAt:null,sourceCommandId:null,accountMode:'LIVE',source:'fixture'});
let pending:Array<{url:string,resolve:(value:any)=>void,reject:(reason:unknown)=>void}>;
const feed={isLive:true,stale:false,quality:'clean',source:'mt5_broker',aiUsable:true,warning:null,message:'',lastCandleTime:'2026-11-01T10:00:00.000Z'};
const legacy=(close=105)=>({time:1700000000000,open:100,high:110,low:90,close});
const result=(rows:any[])=>({candles:rows,feedStatus:feed});
const last=()=>seen.at(-1)!;
async function complete(index:number,body:unknown){await act(async()=>{pending[index]!.resolve({ok:true,json:async()=>body});});}
beforeEach(()=>{seen.length=0;pending=[];vi.stubGlobal('fetch',vi.fn((url:string)=>new Promise((resolve,reject)=>pending.push({url,resolve,reject}))));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('position side card request-bound candle evidence',()=>{
 it('accepts the actual endpoint ISO openTime contract without inventing an entry timestamp or UTC authority',async()=>{
  render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,result([{openTime:'2026-11-01T10:00:00.000Z',open:100,high:110,low:90,close:105}]));
  expect(last().candles).toEqual([{time:Date.parse('2026-11-01T10:00:00.000Z'),open:100,high:110,low:90,close:105}]);
  expect(last().displayStatus).toBe('LIVE');expect(last()).not.toHaveProperty('sourceClockQualified');expect(last()).not.toHaveProperty('entryTime');
 });
 it('never renders old candles under a new symbol, including the first pre-effect render',async()=>{
  const view=render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,result([legacy()]));expect(last().candles).toHaveLength(1);
  seen.length=0;view.rerender(<PositionSideCard position={position('USDJPY')}/>);
  expect(seen.filter(p=>p.symbol==='USDJPY').every(p=>p.candles.length===0)).toBe(true);expect(last().displayStatus).not.toBe('LIVE');
  await complete(1,result([legacy(106)]));expect(last().symbol).toBe('USDJPY');expect(last().candles[0].close).toBe(106);
 });
 it('rejects a late old-symbol response after the new request succeeds',async()=>{
  const view=render(<PositionSideCard position={position('EURUSD')}/>);view.rerender(<PositionSideCard position={position('USDJPY')}/>);
  await complete(1,result([legacy(106)]));await complete(0,result([legacy(105)]));expect(last().symbol).toBe('USDJPY');expect(last().candles[0].close).toBe(106);
 });
 it('retains same-symbol history during refresh while withdrawing the old LIVE verdict',async()=>{
  render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,result([legacy()]));fireEvent.click(screen.getByTestId('btn-refresh-analysis'));
  expect(pending).toHaveLength(2);expect(last().candles).toHaveLength(1);expect(last().displayStatus).not.toBe('LIVE');await complete(1,result([legacy(106)]));expect(last().candles[0].close).toBe(106);
 });
 it('rejects malformed explicit openTime rather than falling back to another timestamp',async()=>{
  render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,result([{...legacy(),openTime:'not-a-time'},{...legacy(),openTime:'2026-11-01T10:00:00'}]));expect(last().candles).toEqual([]);
 });
 it('never fills missing monetary OHLC fields with zero or coerces null',async()=>{
  render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,result([{...legacy(),close:null},{time:1700000000000,open:100,high:110,low:90},{...legacy(),high:Infinity}]));expect(last().candles).toEqual([]);
 });
 it('clears the prior error when selecting a different symbol and rejects old error delivery',async()=>{
  const view=render(<PositionSideCard position={position('EURUSD')}/>);await act(async()=>pending[0]!.reject(new Error('Old source failed')));expect(screen.getByText(/Old source failed/)).toBeTruthy();
  view.rerender(<PositionSideCard position={position('USDJPY')}/>);expect(screen.queryByText(/Old source failed/)).toBeNull();await complete(1,result([legacy(106)]));expect(last().candles[0].close).toBe(106);
 });
 it.each([
  {symbol:'USDJPY',candles:[legacy()],feedStatus:feed},
  {symbol:'EURUSD',timeframe:'H1',candles:[legacy()],feedStatus:feed},
  {candles:[{...legacy(),symbol:'USDJPY'}],feedStatus:feed},
  {candles:[{...legacy(),timeframe:'H1'}],feedStatus:feed},
  {candles:[legacy()],feedStatus:{...feed,symbol:'USDJPY'}},
  {candles:[legacy()],feedStatus:{...feed,timeframe:'H1'}},
 ])('withholds contradictory response metadata with a readable reason',async body=>{
  render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,body);expect(last().candles).toEqual([]);expect(last().displayStatus).not.toBe('LIVE');expect(screen.getByText(/does not match/)).toBeTruthy();
 });
 it('uses only existing exact registry aliases, not fuzzy matches, for declared response symbols',async()=>{
  const view=render(<PositionSideCard position={position('Volatility 75 Index')}/>);await complete(0,{symbol:'V75',timeframe:'M15',candles:[{...legacy(),symbol:'V75',timeframe:'M15'}],feedStatus:feed});expect(last().candles).toHaveLength(1);
  view.rerender(<PositionSideCard position={position('Volatility 7')}/>);await complete(1,{symbol:'V75',candles:[legacy()],feedStatus:feed});expect(last().candles).toEqual([]);expect(screen.getByText(/does not match/)).toBeTruthy();
 });
 it('rejects invalid calendar dates and missing times instead of manufacturing a bar',async()=>{
  render(<PositionSideCard position={position('EURUSD')}/>);await complete(0,result([{...legacy(),openTime:'2026-02-30T10:00:00.000Z'},{open:100,high:110,low:90,close:105},{...legacy(),time:NaN}]));expect(last().candles).toEqual([]);
 });

});
