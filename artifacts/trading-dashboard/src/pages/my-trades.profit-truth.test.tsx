import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import MyTradesPage from './my-trades';
const h=vi.hoisted(()=>({snapshot:null as any}));
vi.mock('@/hooks/useLiveAccountSnapshot',()=>({useLiveAccountSnapshot:()=>({snapshot:h.snapshot,isUnavailable:false,isEstimate:false,freshness:'fresh',live:null,autoRefreshEnabled:true})}));
vi.mock('@/lib/use-chart-symbol',()=>({useChartSymbol:()=>['EURUSD',vi.fn()]}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Ruby'})}));
vi.mock('@/components/trading/ConfirmCloseModal',()=>({ConfirmCloseModal:()=>null}));
vi.mock('@/components/trading/QuickTradeModal',()=>({QuickTradeModal:()=>null}));
vi.mock('@workspace/api-client-react',()=>({useGetTimingBrainMulti:()=>({data:{results:[]}}),getGetTimingBrainMultiQueryKey:()=>['timing']}));
vi.mock('wouter',()=>({Link:({children}:any)=><a>{children}</a>,useLocation:()=>['/my-trades',vi.fn()]}));
const card=(id:string,pnl:number|null)=>({id,source:'user_owned_mt5',routingMode:'USER_OWNED_MT5',accountType:'live',symbol:id==='1'?'EURUSD':'GBPUSD',side:'BUY',lotSize:1,entryPrice:1,currentPrice:1.1,stopLoss:.9,takeProfit:1.2,unrealizedPnl:pnl,pnlIsEstimate:false,pnlPercent:null,status:'open',openedAt:null,brokerLabelMasked:'fixture'});
beforeEach(()=>{h.snapshot={openPL:null,openPositionsCount:2,reconciliation:{positionPnlComplete:false},positions:[]};});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each([null,20])('an unavailable snapshot total never falls back to a seemingly complete dollar sum (second=%s)',async value=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({cards:[card('1',10),card('2',value)],bannerLabel:'LIVE',tradingMode:'LIVE'})})));
 render(<MyTradesPage/>);await screen.findAllByText('EURUSD');
 expect(screen.getByTestId('open-trades-position-subtotal').textContent).toContain('—');
 expect(screen.getByText('Row subtotal (unverified)').parentElement?.textContent).toContain(value===null?'—':'30 (currency unverified)');
 expect(screen.queryByText(/net positive right now|net negative right now/)).toBeNull();
 expect(screen.getByText(/do not establish account-wide profit or loss/)).toBeTruthy();
});
it('legacy missing completeness cannot override unknown aggregate evidence',async()=>{
 h.snapshot={openPL:10,openPositionsCount:2,positions:[]};
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({cards:[card('1',10),card('2',null)],bannerLabel:'LIVE'})})));
 render(<MyTradesPage/>);await screen.findAllByText('EURUSD');
 expect(screen.getByTestId('open-trades-position-subtotal').textContent).toContain('—');
});
