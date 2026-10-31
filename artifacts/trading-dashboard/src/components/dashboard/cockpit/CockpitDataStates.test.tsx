import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CriticalEventsCard, AlertsSummaryCard, TodayPerformanceCard } from './CockpitCards';
import { BestMarketsCard, AvoidMarketsCard } from './CockpitTimingWidgets';
const state=vi.hoisted(()=>({data:undefined as any,isError:false,isLoading:false,dataUpdatedAt:0}));
vi.mock('@workspace/api-client-react',()=>({
 useGetEconomicCalendar:()=>state,useGetCriticalAlerts:()=>state,useGetPerformanceSummary:()=>state,
 useGetTimingBrainMulti:()=>state,getGetTimingBrainMultiQueryKey:()=>['timing'],
}));
vi.mock('wouter',()=>({Link:({children,href}:any)=><a href={href}>{children}</a>}));
vi.mock('@/hooks/useLiveAccountSnapshotContext',()=>({useLiveAccountSnapshotCtx:()=>({})}));
vi.mock('@/hooks/useTradingMode',()=>({useTradingMode:()=>({})}));
vi.mock('@/lib/symbol-context',()=>({useActiveSymbol:()=>['EURUSD']}));
vi.mock('@/lib/assistant-name',()=>({useAssistantName:()=>({name:'Eleanor'})}));
afterEach(cleanup);beforeEach(()=>Object.assign(state,{data:undefined,isError:false,isLoading:false,dataUpdatedAt:0}));
const cards=[CriticalEventsCard,AlertsSummaryCard,TodayPerformanceCard,BestMarketsCard,AvoidMarketsCard];
describe('cockpit missing data is not an all-clear',()=>{
 for(const Card of cards)it(`${Card.name}: failed request stays unavailable`,()=>{state.isError=true;render(<Card/>);expect(screen.getByText(/unavailable/i)).toBeTruthy();expect(screen.queryByText(/No major|No high-impact|No A-grade|Place or close your first|manageable/i)).toBeNull()});
 for(const Card of cards)it(`${Card.name}: malformed successful response stays unavailable`,()=>{state.data={unexpected:true};render(<Card/>);expect(screen.getByText(/unavailable/i)).toBeTruthy()});
 it('calendar empty response is scoped to returned data',()=>{state.data=[];render(<CriticalEventsCard/>);expect(screen.getByText(/No high-impact events returned/i)).toBeTruthy()});
 it('alerts refetch failure does not claim cached empty data is current',()=>{state.data=[];state.isError=true;render(<AlertsSummaryCard/>);expect(screen.getByText(/unavailable/i)).toBeTruthy();expect(screen.queryByText(/No major alerts/)).toBeNull()});
 it('timing empty success is missing coverage, not manageable conditions',()=>{state.data={results:[]};render(<AvoidMarketsCard/>);expect(screen.getByText(/unavailable/i)).toBeTruthy();expect(screen.queryByText(/manageable|No major red/)).toBeNull()});
 it('alerts without timestamps are not assigned the current time',()=>{state.data=[{id:1,title:'Unknown time alert'}];render(<AlertsSummaryCard/>);expect(screen.getByText(/Time unavailable/)).toBeTruthy();expect(screen.queryByText(/Last seen/)).toBeNull()});
 it('alert repeats do not claim all occurrences happened today',()=>{state.data=[{id:1,title:'Repeated',createdAt:'2026-10-20T12:00:00Z'},{id:2,title:'Repeated',createdAt:'2026-10-21T12:00:00Z'}];render(<AlertsSummaryCard/>);expect(screen.queryByText(/times today/)).toBeNull();expect(screen.getByText(/2 occurrences in this response/)).toBeTruthy()});
 it('loading does not announce an empty result',()=>{state.isLoading=true;render(<CriticalEventsCard/>);expect(screen.queryByText(/No high-impact/)).toBeNull()});
});

const timing=(overrides:Record<string,unknown>={})=>({symbol:'EURUSD',generatedAt:'2026-10-30T12:00:00Z',entryPermission:'GO',timingGrade:'B',heatScore:42,tradeabilityScore:50,dangerScore:10,heatState:'COOL',bestAction:'WAIT',dataQuality:{label:'real',hasCandleData:true,hasQuoteData:true},...overrides});
describe('response boundaries and coverage',()=>{
 it('a real B-grade row is a candidate with explicit partial coverage and generated time',()=>{state.data={results:[timing()]};state.dataUpdatedAt=Date.now();render(<BestMarketsCard/>);expect(screen.getByText('EURUSD')).toBeTruthy();expect(screen.getByText(/Partial coverage/)).toBeTruthy();expect(screen.getByText(/Read generated/)).toBeTruthy();expect(screen.queryByText(/live market provider/)).toBeNull()});
 for(const label of ['basic_timing_estimate','partial','unavailable'])it(`does not grade ${label} as a provider-backed candidate`,()=>{state.data={results:[timing({dataQuality:{label,hasCandleData:false,hasQuoteData:false}})]};render(<BestMarketsCard/>);expect(screen.getByText(/unavailable/)).toBeTruthy();expect(screen.queryByText('EURUSD')).toBeNull()});
 it('failed refresh withdraws cached candidates',()=>{state.data={results:[timing()]};state.isError=true;render(<BestMarketsCard/>);expect(screen.getByText(/unavailable/)).toBeTruthy();expect(screen.queryByText('EURUSD')).toBeNull()});
 for(const overrides of [{symbol:'UNREQUESTED'},{dangerScore:NaN},{generatedAt:'bad'},{generatedAt:'2999-01-01T00:00:00Z'},{timingGrade:'INVALID'}])it(`rejects malformed timing evidence ${JSON.stringify(overrides)}`,()=>{state.data={results:[timing(overrides)]};render(<AvoidMarketsCard/>);expect(screen.getByText(/unavailable/)).toBeTruthy()});
 it('duplicate symbol evidence cannot inflate market coverage',()=>{state.data={results:[timing(),timing({entryPermission:'STAND_DOWN'})]};render(<AvoidMarketsCard/>);expect(screen.getByText(/unavailable/)).toBeTruthy()});
 it('valid caution remains visible with response-limited coverage',()=>{state.data={results:[timing({entryPermission:'STAND_DOWN',timingGrade:'D',dangerScore:75})]};render(<AvoidMarketsCard/>);expect(screen.getByText('EURUSD')).toBeTruthy();expect(screen.getByText('D:75')).toBeTruthy();expect(screen.getByText(/Partial coverage/)).toBeTruthy()});
 it('malformed calendar row cannot render Invalid Date',()=>{state.data=[{id:1,title:'Broken',eventTime:'bad'}];render(<CriticalEventsCard/>);expect(screen.getByText(/unavailable/i)).toBeTruthy();expect(screen.queryByText(/Invalid Date/)).toBeNull()});
 it('malformed alerts payload cannot crash grouping',()=>{state.data={alerts:'not an array'};render(<AlertsSummaryCard/>);expect(screen.getByText(/unavailable/i)).toBeTruthy()});
 it('valid empty alerts remains a response-scoped empty state',()=>{state.data={alerts:[]};render(<AlertsSummaryCard/>);expect(screen.getByText(/No critical alerts returned/)).toBeTruthy()});
 it('unknown closed results remain explicit even if known-trade count is zero',()=>{state.data={totalTrades:0,winningTrades:0,losingTrades:0,excludedUnknownCount:3,todayPnl:0,winRate:0,bestTradePnl:0};render(<TodayPerformanceCard/>);expect(screen.getByText(/3 closed trade results are unknown/)).toBeTruthy();expect(screen.getByText(/No closed trades with known results/)).toBeTruthy()});
 it('performance separates all-time counts from UTC daily profit and preserves a zero best trade',()=>{state.data={totalTrades:2,winningTrades:0,losingTrades:1,excludedUnknownCount:0,todayPnl:-5,winRate:0,bestTradePnl:0};render(<TodayPerformanceCard/>);expect(screen.getByText(/All-time closed trades/)).toBeTruthy();expect(screen.getByText("Today's realized P/L (UTC)")).toBeTruthy();expect(screen.getByText(/Best trade \(all time\)/)).toBeTruthy();expect(screen.queryByText('—')).toBeNull()});
});
