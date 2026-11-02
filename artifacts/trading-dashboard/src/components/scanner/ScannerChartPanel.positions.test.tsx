import { useLayoutEffect } from "react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {LiveAccountSnapshotProvider} from "@/hooks/useLiveAccountSnapshotContext";
import {chartCandlesQueryKey} from "@/lib/chartCandlesQuery";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  timeframe: "8h", candles: null as any, intelligence: null as any, annotations: [] as any[],
  intelligenceHook: vi.fn(), layersHook: vi.fn(), applyStructure: vi.fn(),
  surface: null as any, headerRenders: 0, trade: false, execute: vi.fn(),
}));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", vi.fn()], bareSymbol: (value: string) => value }));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => [h.timeframe, vi.fn()] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => ({ truth: null }) }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => ({ news: null, verdict: null }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isPaper: !h.trade, isLiveShared:h.trade, canManualTrade:h.trade, isFrozen:!h.trade }) }));
vi.mock("@/hooks/useProductRole", () => ({ useProductRole: () => ({ isInvestor: true }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./selectedActionStore", () => ({ SelectedActionStoreProvider: ({children}:any) => children, useSelectedActionStore: () => ({ get: () => null }) }));
vi.mock("./rubyReadStore", () => ({ RubyReadStoreProvider: ({children}:any) => children, useRubyReadStore: () => ({ get: () => null }) }));
vi.mock("./RubyChartRead", () => ({ RubyChartRead: () => null }));
vi.mock("@/components/mt5/OneClickArmedBadge", () => ({ OneClickArmedBadge: () => null }));
vi.mock("@workspace/api-client-react", async importOriginal => ({
  ...await importOriginal<any>(),
  useGetMeChartIntelligence: (params: any, options: any) => { h.intelligenceHook(params, options); return { data: h.intelligence }; },
  useGetMeChartSmartLayers: (params: any, options: any) => { h.layersHook(params, options); return { data: undefined }; },
  useGetMeChartAnnotations: () => ({ data: { annotations: h.annotations } }),
  usePostMeChartAnnotation: () => ({ mutate: vi.fn() }),
  useDeleteMeChartAnnotation: () => ({ mutate: vi.fn() }),
  usePostMeChartAiAlertsScan: () => ({ mutate: vi.fn() }),
  useGetAlertPreferences: () => ({ data: undefined }),
  useGetMeTradeHealth: () => ({ data: undefined }),
  useGetTimingBrain: () => ({ data: undefined }),
}));
vi.mock("@/lib/chart-engine/structureLines", () => ({
  EMPTY_STRUCTURE_HANDLES: { series: [], markersApi: null },
  clearStructureLines: vi.fn(),
  applyStructureLines: (...args: any[]) => { h.applyStructure(...args); return { series: [], markersApi: null }; },
}));
vi.mock("@/components/charts/ARXNativeChart", () => ({
  ARXNativeChart: ({ onScannerSurfaceChange, timeframe, externalFeed, workspaceId }: any) => {
    const identity = externalFeed?.data?.marketEvidence?.sourceIdentity;
    useLayoutEffect(() => { onScannerSurfaceChange?.(h.surface); return () => onScannerSurfaceChange?.(null); }, [onScannerSurfaceChange, timeframe, identity]);
    return <div data-testid="native-chart" data-workspace={workspaceId ?? "primary"} data-external={!!externalFeed}>{timeframe}</div>;
  },
}));


vi.mock('@/lib/instantTradeRouter',()=>({executeInstantTrade:(...args:any[])=>h.execute(...args)}));
import {ScannerChartPanel} from './ScannerChartPanel';
import {getUnifiedPositionsQueryKey} from '@/hooks/unifiedPositions';
class Stream {static OPEN=1;static instances:Stream[]=[];readyState=0;onerror:(()=>void)|null=null;listeners:((event:{data:string})=>void)[]=[];
 constructor(){Stream.instances.push(this);}addEventListener(_type:string,listener:(event:{data:string})=>void){this.listeners.push(listener);}close(){this.readyState=2;}emit(value:unknown){this.listeners.forEach(fn=>fn({data:JSON.stringify(value)}));}}
const user={id:1,role:'USER'};
const row=(pnl=1,symbol='EURUSD')=>({scope:'live',brokerTicket:'11',symbol,side:'BUY',lotSize:1,entryPrice:1.1,currentPrice:1.2,stopLoss:1,takeProfit:1.4,floatingPnl:pnl,accountMode:'LIVE',openedAt:null,sourceCommandId:null,source:'MT5_LIVE_BRIDGE'});
const report=(rows:unknown[])=>({ok:true,live:rows,demo:[],liveCount:rows.length,demoCount:0});
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
let client:QueryClient,stored:unknown,failed:boolean,fetcher:ReturnType<typeof vi.fn>;
const calls=()=>fetcher.mock.calls.filter(([url])=>String(url).endsWith('/api/me/positions/all'));
const flush=async(ms=0)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
beforeEach(()=>{
 vi.useFakeTimers();vi.clearAllMocks();h.headerRenders=0;h.trade=false;localStorage.clear();Stream.instances=[];h.timeframe='15m';h.annotations=[];h.surface=null;h.intelligence=null;failed=false;stored=report([row()]);
 const symbol='EURUSD',timeframe='M15',source='mt5_broker';const feedStatus={symbol,source,quality:'clean',isLive:true,stale:false,aiUsable:true};
 const bar={symbol,timeframe,source,openTime:'2026-01-01T00:00:00Z',open:1.1,high:1.3,low:1,close:1.2};const marketEvidence={symbol,timeframe,source,sourceIdentity:'fixture',lastClosedCandleAt:null};
 h.candles={candles:[{...bar,time:Date.parse(bar.openTime)}],feedStatus,marketEvidence,originalResponse:{symbol,timeframe,candles:[bar],feedStatus,marketEvidence,quality:'clean',aiUsable:true}};
 client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});client.setQueryData(['me'],user);client.setQueryData(chartCandlesQueryKey(symbol,timeframe,200),h.candles);
 fetcher=vi.fn(async(url:unknown)=>{const path=String(url);if(path.endsWith('/api/me'))return response({user});if(path.endsWith('/api/me/positions/all')){if(failed)throw Error('offline');return response(stored);}if(path.includes('/api/chart/candles'))return response(h.candles.originalResponse);if(path.endsWith('/pending-order-drafts'))return response({drafts:[]});return response({});});
 Object.defineProperty(document,'hidden',{configurable:true,value:false});vi.stubGlobal('EventSource',Stream);vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{cleanup();client.clear();vi.unstubAllGlobals();vi.useRealTimers();});
const mount=()=>render(<QueryClientProvider client={client}><LiveAccountSnapshotProvider><ScannerChartPanel/></LiveAccountSnapshotProvider></QueryClientProvider>);
it('same canonical change hint updates Scanner reported P/L before its old ten-second poll',async()=>{
 mount();await flush(1);expect(screen.getByTestId('scanner-chart-pos-11')).toBeTruthy();
 stored=report([row(-12.345)]);act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(screen.getByTestId('scanner-chart-pos-11').textContent).toContain('-12.345');expect(calls()).toHaveLength(2);
 expect(screen.getByTestId('scanner-chart-position-evidence').textContent).toMatch(/last reported/i);
 expect(fetcher.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
});
it('canonical failure removes prior Scanner position money and a different symbol stays separate',async()=>{
 mount();await flush(1);failed=true;act(()=>Stream.instances[0]!.emit({type:'shared_account_changed'}));await flush(30);
 expect(screen.queryByTestId('scanner-chart-pos-11')).toBeNull();
 failed=false;stored=report([row(22,'GBPUSD')]);act(()=>Stream.instances[0]!.emit({type:'shared_account_changed'}));await flush(30);expect(screen.queryByTestId('scanner-chart-pos-11')).toBeNull();
});
it('failed identity immediately withholds cached Scanner money and pauses owned reads',async()=>{
 mount();await flush(1);act(()=>client.getQueryCache().find({queryKey:['me'],exact:true})!.setState({status:'error',error:Error('identity unavailable')}));await flush(1);
 expect(screen.queryByTestId('scanner-chart-pos-11')).toBeNull();const count=calls().length;act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);expect(calls()).toHaveLength(count);
});
it('paused chart reload refreshes canonical positions without enabling account streaming',async()=>{
 localStorage.setItem('arx_autoRefresh_enabled','false');mount();await flush(1);stored=report([row(-0.00125)]);
 fireEvent.click(screen.getByTestId('scanner-chart-reload'));await flush(30);
 expect(client.getQueryData(getUnifiedPositionsQueryKey(1))).toMatchObject({live:[{floatingPnl:-0.00125}]});expect(screen.getByTestId('scanner-chart-pos-11').textContent).toContain('-0.00125');expect(Stream.instances).toHaveLength(0);
});
it('a slow pending-draft request cannot delay independently available position evidence',async()=>{
 const normal=fetcher.getMockImplementation()!;fetcher.mockImplementation((url,opts)=>String(url).endsWith('/pending-order-drafts')?new Promise(()=>{}):normal(url,opts));mount();await flush(1);
 expect(screen.getByTestId('scanner-chart-pos-11')).toBeTruthy();expect(screen.getByTestId('native-chart')).toBeTruthy();
});

// Real page/provider + real Scanner panel; unrelated scanner boards are inert.
vi.mock('@/hooks/useViewMode',()=>({useViewMode:()=>({realIsAdmin:false})}));
vi.mock('@/lib/api/safeJson',()=>({safeJson:async()=>({ok:true,data:{universes:[],opportunities:[],running:false}})}));
vi.mock('@/components/scanner/ScannerHeaderSummary',()=>({ScannerHeaderSummary:()=>{h.headerRenders++;return <div data-testid="scanner-header-fixture"/>;}}));
vi.mock('@/components/trading/SetupQualityBadge',()=>({SetupQualityBadge:()=>null}));
vi.mock('@/components/scanner/RubySetupReason',()=>({RubySetupReason:()=>null}));
vi.mock('@/components/scanner/ScannerTimingBadges',()=>({ScannerTimingBadges:()=>null}));
vi.mock('@/components/scanner/ScannerTradeModal',()=>({ScannerTradeModal:()=>null}));
vi.mock('@/components/scanner/RecentScannerTrades',()=>({RecentScannerTrades:()=>null}));
vi.mock('@/components/live/MasterLiveAccessGuard',()=>({MasterLiveAccessBanner:()=>null}));
vi.mock('@/components/scanner/SelectedMarketPanel',()=>({SelectedMarketPanel:()=>null}));
vi.mock('@/components/scanner/ScannerDataHealthPanel',()=>({ScannerDataHealthPanel:()=>null}));
vi.mock('@/components/news/HighImpactEventBanner',()=>({HighImpactEventBanner:()=>null}));
vi.mock('@/components/scanner/SymbolExplorer',()=>({SymbolExplorer:()=>null}));
vi.mock('@/components/live/TradeHealthPanel',()=>({TradeHealthPanel:()=>null}));
vi.mock('@/components/scanner/RubyScalpFocusCard',()=>({RubyScalpFocusCard:()=>null}));
vi.mock('@/components/scanner/RubyScalpRanking',()=>({RubyScalpRanking:()=>null}));
vi.mock('@/components/scanner/RubyMarketReadCard',()=>({RubyMarketReadCard:()=>null}));
vi.mock('@/components/scanner/GlobalMarketHeatCard',()=>({GlobalMarketHeatCard:()=>null}));
vi.mock('@/components/scanner/TimingIntelligenceCard',()=>({TimingIntelligenceCard:()=>null}));
vi.mock('@/components/scanner/ScannerReadGate',()=>({ScannerReadGate:()=>null}));
vi.mock('@/components/scanner/BroadScanOpportunityMap',()=>({BroadScanOpportunityMap:()=>null}));
vi.mock('@/components/scanner/RubyScalpBuilder',()=>({RubyScalpBuilder:()=>null}));
vi.mock('@/components/scanner/RubyScalpBasketPanel',()=>({RubyScalpBasketPanel:()=>null}));
vi.mock('@/components/scanner/RubyScalpReviewPanel',()=>({RubyScalpReviewPanel:()=>null}));

import MarketScanner from '@/pages/market-scanner';
it('real Scanner page owns one stream, renders chart immediately and isolates account tick renders to its small control',async()=>{
 render(<QueryClientProvider client={client}><MarketScanner/></QueryClientProvider>);
 expect(screen.getByTestId('native-chart')).toBeTruthy();await flush(1);
 expect(Stream.instances).toHaveLength(1);const headers=h.headerRenders;
 act(()=>Stream.instances[0]!.emit({type:'account_snapshot',snapshot:{userId:'1',accountMode:'UNKNOWN',freshness:'unavailable',positions:[],warnings:[]}}));await flush(30);
 expect(h.headerRenders).toBe(headers);expect(Stream.instances).toHaveLength(1);
 expect(screen.getByRole('button',{name:'Refresh'})).toBeTruthy();
 stored=report([row(-7.123)]);act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(screen.getByTestId('scanner-chart-pos-11').textContent).toContain('-7.123');
});

it.each(['identity','failure','removed'])('Scanner retained attached close handler cannot submit after %s',async transition=>{
 h.trade=true;mount();await flush(1);const button=screen.getByTestId('scanner-chart-close-11');
 act(()=>{if(transition==='identity')client.setQueryData(['me'],{id:2,role:'USER'});
 else if(transition==='failure')client.getQueryCache().find({queryKey:getUnifiedPositionsQueryKey(1),exact:true})!.setState({status:'error',error:Error('withdrawn')});
 else client.setQueryData(getUnifiedPositionsQueryKey(1),report([]));
 expect(button.isConnected).toBe(true);fireEvent.click(button);});await flush(1);expect(h.execute).not.toHaveBeenCalled();
});

it('canonical withdrawal also disposes visible position price lines on the existing chart surface',async()=>{
 const lines:Array<{options:any;dispose:ReturnType<typeof vi.fn>}>=[];
 h.surface={container:document.createElement('div'),dispose:vi.fn(),priceToCoordinate:()=>100,coordinateToPrice:()=>1.2,createMarkers:()=>({dispose:vi.fn()}),createPriceLine:(options:any)=>{const line={options,dispose:vi.fn()};lines.push(line);return line;}};
 mount();await flush(1);const entry=lines.find(line=>line.options.title.includes('Entry'))!;expect(entry.options.price).toBe(1.1);
 failed=true;act(()=>Stream.instances[0]!.emit({type:'personal_account_changed'}));await flush(30);
 expect(entry.dispose).toHaveBeenCalled();expect(screen.queryByTestId('scanner-chart-pos-11')).toBeNull();
 expect(lines.filter(line=>!line.dispose.mock.calls.length&&line.options.title.includes('Entry'))).toHaveLength(0);
});

it.each(['close','be','reverse'])('a retained DEMO report cannot send %s through the selected LIVE mode',async action=>{
 h.trade=true;h.execute.mockResolvedValue({ok:false,error:'fixture refusal'});
 stored={ok:true,live:[],demo:[{...row(),scope:'demo',accountMode:'DEMO'}],liveCount:0,demoCount:1};
 mount();await flush(1);fireEvent.click(screen.getByTestId(`scanner-chart-${action}-11`));await flush(1);
 expect(h.execute).not.toHaveBeenCalled();
});
