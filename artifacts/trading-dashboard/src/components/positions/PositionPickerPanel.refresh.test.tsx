import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {QueryClient,QueryClientProvider,focusManager,onlineManager} from '@tanstack/react-query';
import {LiveAccountSnapshotProvider,useLiveAccountSnapshotCtx} from '@/hooks/useLiveAccountSnapshotContext';
import {useLiveBridgeRefreshState} from '@/hooks/useLiveBridgeRefresh';
import {LiveBridgeAutoRefreshControl} from '@/components/live/LiveBridgeAutoRefreshControl';
import {PositionPickerPanel} from './PositionPickerPanel';
vi.mock('./PositionMiniChart',()=>({PositionMiniChart:()=> <div data-testid="mini"/>}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:vi.fn()})}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
vi.mock('@/lib/use-chart-symbol',()=>({setChartSymbol:vi.fn(),useChartSymbol:()=>['EURUSD',vi.fn()]}));
vi.mock('@/components/charts/ARXNativeChart',()=>({ARXNativeChart:()=> <div/>}));
vi.mock('@/components/charts/SmartChartLayout',()=>({SmartChartLayout:({children}:any)=>children}));
vi.mock('@/components/charts/SmartChartView',()=>({SmartChartSymbolSelect:()=>null}));
vi.mock('@/lib/chart-engine',()=>({DEFAULT_CHART_ENGINE_ID:'arx-native',CHART_ENGINE_DESCRIPTORS:{'arx-native':{label:'ARX'}}}));
vi.mock('@/components/charts/ChartPositionOverlayPanel',()=>({ChartPositionOverlayPanel:()=>null}));
vi.mock('@/components/charts/ChartAiOverlayPanel',()=>({ChartAiOverlayPanel:()=>null}));
vi.mock('@/components/charts/ChartSetupPreviewPanel',()=>({ChartSetupPreviewPanel:()=>null}));
vi.mock('@/components/charts/ChartModes',()=>({ChartModes:()=>null}));
vi.mock('@/components/charts/ChartTradeEntry',()=>({ChartTradeEntry:()=>null}));
vi.mock('@/hooks/useLivePositionOverlays',()=>({useLivePositionOverlays:()=>({overlays:[]})}));
vi.mock('@/hooks/useAiChartOverlays',()=>({useAiChartOverlays:()=>({overlays:[]})}));
vi.mock('@/hooks/useChartSetupPreview',()=>({useChartSetupPreview:()=>({overlays:[]})}));
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>({cleanModeLabel:'DEMO',isLiveShared:false})}));
vi.mock('@/hooks/useProductRole',()=>({useProductRole:()=>({isInvestor:true,isLoading:false})}));
import LiveChartPage from '@/pages/live-chart';
import {getUnifiedPositionsQueryKey} from '@/hooks/unifiedPositions';
class Stream {
 static OPEN=1;static instances:Stream[]=[];readyState=0;onerror:(()=>void)|null=null;listeners:((event:{data:string})=>void)[]=[];
 constructor(){Stream.instances.push(this);}addEventListener(_type:string,listener:(event:{data:string})=>void){this.listeners.push(listener);}close(){this.readyState=2;}
 emit(value:unknown){this.readyState=1;this.listeners.forEach(fn=>fn({data:JSON.stringify(value)}));}
}
const user={id:1,role:'USER',name:'Fixture'};
const position=(pnl:number|null=1)=>({scope:'live',brokerTicket:'11',symbol:'EURUSD',side:'BUY',lotSize:1,entryPrice:100,currentPrice:101,stopLoss:90,takeProfit:120,floatingPnl:pnl,openedAt:null,sourceCommandId:null,accountMode:'LIVE',source:'MT5_LIVE_BRIDGE'});
const envelope=(rows:unknown[])=>({ok:true,live:rows,demo:[],liveCount:rows.length,demoCount:0});
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
let client:QueryClient,fetcher:ReturnType<typeof vi.fn>,stored:unknown,failure:boolean;
beforeEach(()=>{focusManager.setFocused(true);onlineManager.setOnline(true);vi.useFakeTimers();localStorage.clear();Stream.instances=[];failure=false;stored=envelope([position()]);Object.defineProperty(document,'hidden',{configurable:true,value:false});vi.stubGlobal('EventSource',Stream);
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});client.setQueryData(['me'],user);
 fetcher=vi.fn(async(url:unknown)=>{const path=String(url);if(path.endsWith('/api/me'))return response({user});if(path.endsWith('/api/me/positions/all')){if(failure)throw Error('offline');return response(stored);}if(path.includes('/api/chart/candles'))return response({candles:[]});if(path.endsWith('/api/me/live/slot-summary'))return response({dataFreshness:'MISSING',isAllocated:false});throw Error('Unexpected '+path);});vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{cleanup();client.clear();vi.unstubAllGlobals();vi.useRealTimers();});
const flush=async(ms=0)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
function Control(){return <LiveBridgeAutoRefreshControl {...useLiveBridgeRefreshState(useLiveAccountSnapshotCtx())}/>;}
const mount=()=>render(<QueryClientProvider client={client}><LiveAccountSnapshotProvider><Control/><PositionPickerPanel/></LiveAccountSnapshotProvider></QueryClientProvider>);
const calls=()=>fetcher.mock.calls.filter(([url])=>String(url).endsWith('/api/me/positions/all'));
const choose=()=>fireEvent.click(screen.getByTestId('btn-select-position-live-11'));
it.each(['personal_account_changed','shared_account_changed'])('actual picker and selected card reread reported positions on %s before polling',async type=>{
 mount();await flush(1);choose();await flush(1);expect(screen.getByTestId('text-position-pnl').textContent).toMatch(/^\+1(?:\.00)?$/);
 stored=envelope([{...position(-12.345),currentPrice:102,stopLoss:91}]);act(()=>Stream.instances[0]!.emit({type}));await flush(30);
 expect(calls()).toHaveLength(2);expect(screen.getByTestId('text-position-pnl').textContent).toBe('-12.345');expect(screen.getByTestId('text-position-current').textContent).toBe('102');expect(screen.getByTestId('text-position-sl').textContent).toBe('91');
 expect(Stream.instances).toHaveLength(1);expect(calls().every(([,options])=>options.cache==='no-store')).toBe(true);
 expect(fetcher.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
});
it('a read failure withholds prior OPEN position and P/L instead of showing them as current',async()=>{
 mount();await flush(1);choose();await flush(1);failure=true;act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(screen.queryByTestId('position-side-card')).toBeNull();expect(screen.queryByTestId('btn-select-position-live-11')).toBeNull();expect(screen.getByText(/Couldn't load positions/)).toBeTruthy();
 failure=false;stored=envelope([position(0)]);act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(screen.getByTestId('text-position-pnl').textContent).toBe('+0');
});
it('paused explicit Refresh rereads positions while preserving pause, and removal withdraws selection without a close request',async()=>{
 localStorage.setItem('arx_autoRefresh_enabled','false');mount();await flush(1);choose();await flush(1);
 stored=envelope([]);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await flush(30);
 expect(screen.queryByTestId('position-side-card')).toBeNull();expect(calls()).toHaveLength(2);expect(Stream.instances).toHaveLength(0);expect(localStorage.getItem('arx_autoRefresh_enabled')).toBe('false');
 expect(fetcher.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
});

it('actual live-chart parent mounts one existing stream and forwards only matching owned snapshot updates',async()=>{
 render(<QueryClientProvider client={client}><LiveChartPage/></QueryClientProvider>);await flush(1);choose();await flush(1);expect(Stream.instances).toHaveLength(1);
 stored=envelope([position(-3.125)]);
 const snapshot=(userId:string)=>({type:'account_snapshot',snapshot:{userId,accountMode:'UNKNOWN',freshness:'unavailable',positions:[],warnings:[]}});
 act(()=>Stream.instances[0]!.emit(snapshot('2')));await flush(30);expect(calls()).toHaveLength(1);
 act(()=>Stream.instances[0]!.emit(snapshot('1')));await flush(30);expect(calls()).toHaveLength(2);expect(screen.getByTestId('text-position-pnl').textContent).toBe('-3.125');
 expect(screen.getByRole('button',{name:'Refresh'})).toBeTruthy();
});
it('a pre-hint canonical read retains a trailing read; an old response cannot swallow the monetary change',async()=>{
 mount();await flush(1);choose();await flush(1);let resolveOld!:(r:Response)=>void;
 const normal=fetcher.getMockImplementation()!;
 fetcher.mockImplementation((url,options)=>String(url).endsWith('/api/me/positions/all')?new Promise<Response>(resolve=>{resolveOld=resolve;}):normal(url,options));
 const old=client.refetchQueries({queryKey:getUnifiedPositionsQueryKey(1),exact:true});await flush(1);
 act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(1);
 stored=envelope([position(-8.125)]);fetcher.mockImplementation(normal);
 await act(async()=>{resolveOld(response(envelope([position(2)])));await old;});await flush(30);
 expect(calls()).toHaveLength(3);expect(screen.getByTestId('text-position-pnl').textContent).toBe('-8.125');
});
it('identity changes clear old rows and retire old-stream hints; explicit refresh can bind the new identity',async()=>{
 localStorage.setItem('arx_autoRefresh_enabled','false');mount();await flush(1);choose();await flush(1);
 stored=envelope([]);act(()=>client.setQueryData(['me'],{...user,id:2}));await flush(1);
 expect(screen.queryByTestId('position-side-card')).toBeNull();
 stored=envelope([position(7)]);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await flush(30);
 expect(client.getQueryData(getUnifiedPositionsQueryKey(2))).toMatchObject({live:[{floatingPnl:7}]});
});
it('failure to establish identity on an early manual click does not poison later explicit refresh',async()=>{
 localStorage.setItem('arx_autoRefresh_enabled','false');client.setQueryData(['me'],null);
 // Hold identity unavailable for the first click, then supply the authenticated user.
 const normal=fetcher.getMockImplementation()!;fetcher.mockImplementation((url,options)=>String(url).endsWith('/api/me')?Promise.resolve(response({user:null})):normal(url,options));
 mount();await flush(1);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await flush(30);expect(calls()).toHaveLength(0);
 act(()=>client.setQueryData(['me'],user));await flush(1);stored=envelope([position(-2)]);
 fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await flush(30);expect(calls()).toHaveLength(2);expect(client.getQueryData(getUnifiedPositionsQueryKey(1))).toMatchObject({live:[{floatingPnl:-2}]});
});
it('malformed numeric money is withheld rather than coerced; finite zero and large decimals remain reported values',async()=>{
 mount();await flush(1);choose();await flush(1);stored=envelope([{...position(),floatingPnl:'0'}]);act(()=>Stream.instances[0]!.emit({type:'shared_account_changed'}));await flush(30);
 expect(screen.queryByTestId('text-position-pnl')).toBeNull();expect(screen.getByText(/Couldn't load positions/)).toBeTruthy();
 stored=envelope([position(-0)]);act(()=>Stream.instances[0]!.emit({type:'shared_account_changed'}));await flush(30);expect(screen.getByTestId('text-position-pnl').textContent).toBe('+0');
 stored=envelope([position(1234567890.12345)]);act(()=>Stream.instances[0]!.emit({type:'shared_account_changed'}));await flush(30);expect(screen.getByTestId('text-position-pnl').textContent).toBe('+1234567890.12345');
 expect(screen.getByTestId('text-position-risk').textContent).toContain('contract size and currency not supplied');
});

it.each(['identity','failure','removed'])('retires a retained close confirmation on %s and never posts it',async transition=>{
 mount();await flush(1);choose();await flush(1);fireEvent.click(screen.getByTestId('btn-close-position'));expect(screen.getByTestId('modal-confirm-close')).toBeTruthy();
 const oldSubmit=screen.getByTestId('btn-confirm-close');
 if(transition==='identity')act(()=>client.setQueryData(['me'],{...user,id:2}));
 else {if(transition==='failure')failure=true;else stored=envelope([]);act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));}
 await flush(30);expect(screen.queryByTestId('modal-confirm-close')).toBeNull();fireEvent.click(oldSubmit);
 expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(0);
 if(transition==='identity')expect(screen.queryByTestId('position-side-card')).toBeNull();
});

it('cached identity on an errored /me read withholds old monetary rows and controls',async()=>{
 mount();await flush(1);choose();await flush(1);
 act(()=>client.getQueryCache().find({queryKey:['me'],exact:true})!.setState({status:'error',error:Error('Identity unavailable')}));await flush(1);
 expect(client.getQueryData(['me'])).toMatchObject({id:1});expect(screen.getByText('Account identity could not be verified. Position values are hidden.')).toBeTruthy();expect(screen.queryByTestId('position-side-card')).toBeNull();expect(screen.queryByTestId('btn-select-position-live-11')).toBeNull();
 const before=calls().length;act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);expect(calls()).toHaveLength(before);
});
it('repeated manual clicks before identity do not leak cache subscribers across unmount',async()=>{
 localStorage.setItem('arx_autoRefresh_enabled','false');client.setQueryData(['me'],null);
 const normal=fetcher.getMockImplementation()!;fetcher.mockImplementation((url,options)=>String(url).endsWith('/api/me')?Promise.resolve(response({user:null})):normal(url,options));
 const cache=client.getQueryCache(),original=cache.subscribe.bind(cache),active=new Set<unknown>();
 vi.spyOn(cache,'subscribe').mockImplementation(listener=>{active.add(listener);const off=original(listener);return()=>{active.delete(listener);off();};});
 const view=mount();await flush(1);fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await flush(30);const initial=active.size;
 for(let i=0;i<5;i++){fireEvent.click(screen.getByRole('button',{name:'Refresh'}));await flush(30);expect(active.size).toBe(initial);}
 view.unmount();expect(active.size).toBe(0);
});

it.each(['identity','failure','removed'])('rechecks current authority before a still-attached confirmation handler can post after %s',async transition=>{
 mount();await flush(1);choose();await flush(1);fireEvent.click(screen.getByTestId('btn-close-position'));const button=screen.getByTestId('btn-confirm-close');
 act(()=>{
  if(transition==='identity')client.setQueryData(['me'],{...user,id:2});
  else if(transition==='failure')client.getQueryCache().find({queryKey:getUnifiedPositionsQueryKey(1),exact:true})!.setState({status:'error',error:Error('withdrawn')});
  else client.setQueryData(getUnifiedPositionsQueryKey(1),envelope([]));
  expect(button.isConnected).toBe(true);fireEvent.click(button);
 });await flush(1);
 expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(0);
});
it.each([false,true])('positions focus/reconnect reads honor auto-refresh=%s',async enabled=>{
 localStorage.setItem('arx_autoRefresh_enabled',String(enabled));mount();await flush(1);const before=calls().length;
 act(()=>focusManager.setFocused(false));act(()=>focusManager.setFocused(true));await flush(30);
 expect(calls()).toHaveLength(before+(enabled?1:0));
 act(()=>onlineManager.setOnline(false));act(()=>onlineManager.setOnline(true));await flush(30);
 expect(calls()).toHaveLength(before+(enabled?2:0));
});
it('unknown positions count is withheld; a valid empty report establishes zero',async()=>{
 localStorage.setItem('arx_autoRefresh_enabled','false');let resolve!: (r:Response)=>void;const normal=fetcher.getMockImplementation()!;
 fetcher.mockImplementation((url,options)=>String(url).endsWith('/api/me/positions/all')?new Promise<Response>(r=>{resolve=r;}):normal(url,options));mount();await flush(1);
 expect(screen.getByTestId('position-picker-panel').textContent).toContain('Reported open positions—');
 expect(screen.queryByTestId('text-no-open-positions')).toBeNull();
 await act(async()=>{resolve(response(envelope([])));});await flush(1);expect(screen.getByTestId('position-picker-panel').textContent).toContain('Reported open positions0');expect(screen.getByTestId('text-no-open-positions').textContent).toContain('last received report');
});
it('queued close does not optimistically remove the reported position; only a later empty report does',async()=>{
 const normal=fetcher.getMockImplementation()!;fetcher.mockImplementation((url,options)=>String(url).endsWith('/positions/11/close')?Promise.resolve(response({ok:true})):normal(url,options));
 mount();await flush(1);choose();await flush(1);fireEvent.click(screen.getByTestId('btn-close-position'));fireEvent.click(screen.getByTestId('btn-confirm-close'));await flush(1);
 expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);expect(screen.getByTestId('text-position-status').textContent).toBe('Reported open');
 stored=envelope([]);act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);expect(screen.queryByTestId('position-side-card')).toBeNull();
});
