import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { AccountSnapshotCard, OpenPositionsCard } from './CockpitCards';
const h=vi.hoisted(()=>({summary:{} as any,positions:{} as any,live:{} as any,mode:{} as any}));
vi.mock('@workspace/api-client-react',()=>({useGetMt5Status:()=>({data:null,isError:false}),getGetMt5StatusQueryKey:()=>['/api/mt5/status'],useGetMeSharedAccountSummary:()=>h.summary,getGetMeSharedAccountSummaryQueryKey:()=>['summary'],useGetMeSharedAccountPositions:()=>h.positions,getGetMeSharedAccountPositionsQueryKey:()=>['positions']}));
vi.mock('@/hooks/useLiveAccountSnapshotContext',()=>({useLiveAccountSnapshotCtx:()=>h.live}));
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>h.mode}));
vi.mock('@/lib/symbol-context',()=>({useActiveSymbol:()=>['EURUSD']}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
vi.mock('wouter',()=>({Link:({href,children}:any)=><a href={href}>{children}</a>}));
beforeEach(()=>{h.summary={isLoading:false,isError:true};h.positions={isLoading:false,isError:true};h.live={snapshot:null,isUnavailable:true,freshness:'unavailable',lastUpdatedMs:null,isEstimate:false};h.mode={isLiveShared:true,isAdmin:false,isAdminPreviewingUserMode:false,isLoading:false,isError:false}});afterEach(cleanup);
const snapshot=(extra:Record<string,unknown>={})=>({accountMode:'LIVE_SHARED',balance:1000,equity:990,openPL:-10,openPositionsCount:0,positions:[],freshness:'fresh',...extra});
it('missing summary and snapshot show no fabricated zero or Active',()=>{render(<AccountSnapshotCard/>);expect(screen.queryByText('$0.00')).toBeNull();expect(screen.queryByText('Active')).toBeNull();expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)});
it('empty account array does not prove zero holdings',()=>{h.summary={data:{accounts:[]},isError:false};render(<AccountSnapshotCard/>);expect(screen.queryByText('$0.00')).toBeNull()});
it('static virtual balance cannot substitute for missing canonical available headroom',()=>{h.summary={data:{accounts:[{virtualBalance:1000,virtualEquity:900,virtualPnl:-100,openAttributions:1}]}};render(<AccountSnapshotCard/>);expect(within(screen.getByText('Available').parentElement!).getByText('—')).toBeTruthy()});
it('real zero master values remain zero',()=>{h.mode.isAdmin=true;h.summary={data:{masterAccess:true,accounts:[],masterMt5:{arxAllocated:0,mt5Equity:0,mt5OpenPnl:null,openPositions:0,accountCurrency:'USD',snapshotStatus:'FRESH',syncStatus:'LIVE',lastMt5SnapshotAt:new Date().toISOString(),snapshotAgeMs:0}}};render(<AccountSnapshotCard/>);expect(screen.getByText(/ARX allocation: 0 \(currency unverified\)/)).toBeTruthy();expect(screen.getByTestId('native-money-equity').textContent).toBe('—');expect(screen.queryByText('Active')).toBeNull()});
// Legacy SSE scalars no longer represent the selected personal broker report.
it('retained legacy broker values cannot substitute for a selected native report',()=>{h.live.snapshot=snapshot();render(<AccountSnapshotCard/>);expect(screen.queryByText('$990.00')).toBeNull();expect(screen.getByText(/Last-known allocation and position figures/)).toBeTruthy()});
it('a mode mismatch cannot reuse prior live broker values',()=>{h.live.snapshot=snapshot({accountMode:'UNKNOWN'});render(<AccountSnapshotCard/>);expect(screen.queryByText('$990.00')).toBeNull()});
it('non-finite evidence never renders NaN or Infinity',()=>{h.live.snapshot=snapshot({balance:NaN,equity:Infinity,openPL:NaN,openPositionsCount:NaN});render(<AccountSnapshotCard/>);expect(screen.queryByText(/NaN|Infinity/)).toBeNull()});
it('failed positions read without snapshot stays unknown',()=>{render(<OpenPositionsCard/>);expect(screen.getByText(/Position data unavailable/)).toBeTruthy();expect(screen.queryByText('No open positions')).toBeNull();expect(screen.queryByText('0')).toBeNull()});
it('a positive count without rows is incomplete, not empty',()=>{h.live.snapshot=snapshot({openPositionsCount:2});h.live.isUnavailable=false;h.live.freshness='fresh';render(<OpenPositionsCard/>);expect(screen.getByText(/Position details incomplete/)).toBeTruthy();expect(screen.queryByText('No open positions')).toBeNull()});
it('an old empty snapshot never claims no trades right now',()=>{h.live.snapshot=snapshot();h.live.freshness='stale';render(<OpenPositionsCard/>);expect(screen.getByText(/Last reported snapshot contained no positions/)).toBeTruthy();expect(screen.queryByText(/right now/)).toBeNull()});
it('a partial funds poll is not complete position evidence',()=>{h.live.snapshot=snapshot({positionsComplete:false,positionCountKnown:false});h.live.freshness='fresh';h.live.isUnavailable=false;render(<OpenPositionsCard/>);expect(screen.getByText(/Position details incomplete/)).toBeTruthy();expect(screen.queryByText('0')).toBeNull()});
it('a complete fresh zero snapshot is a scoped empty result',()=>{h.live.snapshot=snapshot();h.live.freshness='fresh';h.live.isUnavailable=false;render(<OpenPositionsCard/>);expect(screen.getByText(/Latest snapshot reports no open positions/)).toBeTruthy()});

const master=(extra:Record<string,unknown>={})=>({arxAllocated:500,accountCurrency:'USD',mt5Balance:1000,mt5Equity:900,mt5OpenPnl:null,openPositions:1,accountObservationScope:'LATEST_ACCOUNT_UPDATE',amountsCoherent:false,snapshotStatus:'FRESH',syncStatus:'LIVE',lastMt5SnapshotAt:new Date().toISOString(),snapshotAgeMs:0,...extra});
it('stale master funds cannot borrow a fresh per-user stream badge',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({snapshotStatus:'STALE',syncStatus:'STALE',lastMt5SnapshotAt:new Date(Date.now()-180000).toISOString(),snapshotAgeMs:180000}),accounts:[]},isError:false};
 h.live={...h.live,snapshot:snapshot(),freshness:'live',lastUpdatedMs:Date.now(),isEstimate:false};
 render(<AccountSnapshotCard/>);expect(screen.queryByText('$900.00')).toBeNull();expect(screen.queryByLabelText('Data freshness: Live')).toBeNull();expect(screen.getByText(/Complete MT5 account report unavailable/)).toBeTruthy();
});
it('a recent master update does not certify a coherent set of funds',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master(),accounts:[]},isError:false};h.live.freshness='fresh';
 render(<AccountSnapshotCard/>);expect(screen.getByText(/Complete MT5 account report unavailable/)).toBeTruthy();expect(screen.queryByLabelText('Data freshness: Fresh')).toBeNull();expect(screen.queryByText(/Last account update:/)).toBeNull();expect(screen.queryByText('Active')).toBeNull();
});
it('owner without master evidence never substitutes user allocation figures or freshness',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:null,accounts:[{virtualEquity:77,virtualPnl:12,openAttributions:3,status:'active'}],allocationView:{availableAllocation:123,hasAllocation:true}},isError:false};h.live={...h.live,snapshot:snapshot(),freshness:'live'};
 render(<AccountSnapshotCard/>);expect(screen.queryByText('$77.00')).toBeNull();expect(screen.queryByText('$123.00')).toBeNull();expect(screen.queryByLabelText('Data freshness: Live')).toBeNull();expect(screen.queryByText('Active')).toBeNull();
});
it.each([null,'invalid',new Date(Date.now()+86400000).toISOString()])('master amounts with unverifiable observation time %s stay unknown',stamp=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({lastMt5SnapshotAt:stamp}),accounts:[]},isError:false};h.live.freshness='live';
 render(<AccountSnapshotCard/>);expect(screen.queryByText('$900.00')).toBeNull();expect(screen.queryByLabelText('Data freshness: Live')).toBeNull();
});
it('master reconciliation cannot manufacture a coherent P/L from retained scalar figures',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({mt5OpenPnl:0}),accounts:[]},isError:false};h.mode.shouldShowAdminDiagnostics=true;
 render(<AccountSnapshotCard/>);expect(screen.queryByTestId('account-pl-discrepancy-admin')).toBeNull();expect(screen.getByTestId('native-money-profit').textContent).toBe('—');
});

it('broker equity uses its reported currency, never an assumed dollar',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({accountCurrency:'EUR',nativeAccountReport:nativeReport()}),accounts:[]}};render(<AccountSnapshotCard/>);expect(screen.getByTestId('native-money-equity').textContent).toBe('EUR 900.00');expect(screen.queryByText('$900.00')).toBeNull();
});
it('missing currency stays explicit',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({accountCurrency:null}),accounts:[]}};render(<AccountSnapshotCard/>);expect(screen.getByTestId('native-money-equity').textContent).toBe('—');
});
it('summary-only user figures cannot borrow an unrelated stream badge',()=>{
 h.summary={data:{accounts:[{virtualEquity:77,virtualPnl:12,openAttributions:3}],allocationView:{availableAllocation:123,hasAllocation:true}},isError:false};h.live.freshness='live';h.live.snapshot=null;
 render(<AccountSnapshotCard/>);expect(screen.queryByLabelText('Data freshness: Live')).toBeNull();expect(screen.getByLabelText('Data freshness: Unavailable')).toBeTruthy();
});

it.each([null,0,110])('unmatched account comparison never claims consistent or fabricated delta (%s)',difference=>{
 h.summary={data:{masterAccess:false,accounts:[]},isError:false};h.mode.shouldShowAdminDiagnostics=true;
 h.live={...h.live,snapshot:snapshot({openPositionsCount:1,reconciliation:{snapshotSummedPL:10,equityMinusBalancePL:difference,discrepancy:null,exceedsThreshold:false,excludedCount:0,brokerAbsentExcludedCount:0,stalePLCount:0}}),freshness:'fresh'};
 render(<AccountSnapshotCard/>);const diagnostic=screen.getByTestId('account-pl-discrepancy-admin');
 expect(diagnostic.textContent).not.toMatch(/consistent|Δ: \$0\.00/);expect(diagnostic.textContent).toMatch(/not verified|unverified/i);
 expect(diagnostic.textContent).not.toContain('$');
});
it('partial supplied-position total is unavailable and its scope is explained',()=>{
 h.live={...h.live,snapshot:snapshot({openPL:10,reconciliation:{status:'unverified',positionPnlComplete:false,positionPnlScope:'supplied_rows',snapshotSummedPL:10}}),freshness:'fresh'};
 render(<AccountSnapshotCard/>);expect(within(screen.getByText(/^(Open|Position) P\/L$/).parentElement!).getByText('—')).toBeTruthy();
 expect(screen.getByText(/position.*incomplete/i)).toBeTruthy();
});

it('legacy missing completeness never exposes an aggregate as a known total',()=>{
 h.live={...h.live,snapshot:snapshot({openPL:10,positions:[{unrealizedPL:10},{unrealizedPL:null}]}),freshness:'fresh'};
 render(<AccountSnapshotCard/>);expect(within(screen.getByText('Position P/L').parentElement!).getByText('—')).toBeTruthy();
 expect(screen.getByText(/Position P\/L is incomplete/)).toBeTruthy();
});
it('quote-derived sums are explicitly estimated and never claim broker currency',()=>{
 h.live={...h.live,snapshot:snapshot({openPL:10,reconciliation:{positionPnlComplete:true},positions:[{unrealizedPL:10,plIsEstimate:true,plSource:'computed'}]}),freshness:'live',isEstimate:false};
 render(<AccountSnapshotCard/>);const tile=screen.getByText('Position P/L').parentElement!;
 expect(tile.textContent).toContain('~10 (currency unverified)');expect(tile.textContent).not.toContain('$');
 expect(screen.getByText(/quote-based account-currency conversion is unverified/)).toBeTruthy();
});

it('complete broker-valued supplied rows remain neutral without proven account/currency scope',()=>{
 h.live={...h.live,snapshot:snapshot({openPL:10,reconciliation:{positionPnlComplete:true},positions:[{unrealizedPL:10,plIsEstimate:false,plSource:'broker'}]}),freshness:'live',isEstimate:false};
 render(<AccountSnapshotCard/>);expect(screen.getByText('10 (currency unverified)').className).toContain('text-txt-muted');
});

it.each([undefined,null,{status:"unavailable",amounts:null}])("native report %j cannot fall back to stored money",value=>{h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({nativeAccountReport:value}),accounts:[]},isError:false};render(<AccountSnapshotCard/>);expect(screen.getByTestId("native-money-equity").textContent).toBe("—");expect(screen.queryByText("$900.00")).toBeNull();});

function nativeReport(){return {status:'reported',reason:'CLOCK_AND_CONTINUITY_UNVERIFIED',currentVerified:false,observedAt:new Date(Date.now()-2000).toISOString(),receivedAt:new Date(Date.now()-1000).toISOString(),currency:'EUR',currencyDigits:2,amounts:{balance:'1000.00',equity:'900.00',profit:'-120.00',credit:'20.00',margin:'0.00',freeMargin:'900.00'}};}
it('ordinary account cannot display an accidentally supplied master report',()=>{
 h.summary={data:{masterAccess:false,masterMt5:master({nativeAccountReport:nativeReport()}),accounts:[]},isError:false};render(<AccountSnapshotCard/>);expect(screen.getByTestId('native-money-equity').textContent).toBe('—');expect(screen.queryByText('EUR 900.00')).toBeNull();
});
it('cached native report is withheld when summary reload fails',()=>{
 h.mode.isAdmin=true;h.summary={data:{masterAccess:true,masterMt5:master({nativeAccountReport:nativeReport()}),accounts:[]},isError:true};render(<AccountSnapshotCard/>);expect(screen.getByTestId('native-money-equity').textContent).toBe('—');
});
