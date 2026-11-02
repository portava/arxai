import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
const m=vi.hoisted(()=>({query:{} as any}));
vi.mock('@/hooks/useAdminBrokerMirror',()=>({useAdminBrokerMirror:()=>m.query}));
vi.mock('@workspace/api-client-react',()=>({
 useGetAdminFundBookBrokerMirror:()=>m.query,
 useGetAdminFundBookPlAllocation:()=>({data:{poolKeyById:{},assignedTotal:5}}),
 useGetAdminFundBookPools:()=>({data:{pools:[]}}),
 useGetAdminFundBookReconciliationOverview:()=>({data:{}}),
 useListAdminCapitalRequests:()=>({data:{requests:[]}}),useGetAdminCapitalSettings:()=>({data:{}}),
}));
import {BrokerMirrorsSection} from './BrokerMirrorsSection';
import {OverviewSection} from './OverviewSection';
const now=new Date('2026-11-02T12:00:00.000Z');
const report=()=>({status:'reported',reason:'CLOCK_AND_CONTINUITY_UNVERIFIED',currentVerified:false,observedAt:'2026-11-02T11:59:59.000Z',receivedAt:'2026-11-02T11:59:59.500Z',observationAgeMs:1000,currency:'KWD',currencyDigits:3,amounts:{balance:'9007199254740993.123',equity:'1200.000',profit:'-12.345',credit:'212.345',margin:'0.000',freeMargin:'1200.000'}});
const bridge=()=>({bridgeConnectionId:7,connectionName:'Account A',userId:3,status:'CONNECTED',accountType:'LIVE',accountBalance:1000,accountEquity:1005,margin:0,freeMargin:1005,accountCurrency:null,freshness:'FRESH',freshnessAsOf:now.toISOString(),lastHeartbeatAt:now.toISOString(),openPositionCount:1,floatingPlTotal:5,nativeAccountReport:report()});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);m.query={data:{ok:true,bridges:[bridge()],openPositions:[]},isError:false,isLoading:false,isFetching:false,refetch:vi.fn(),autoRefreshEnabled:true,setAutoRefreshEnabled:vi.fn()};});
afterEach(()=>{cleanup();vi.useRealTimers();});
it('shows all six exact native amounts, not stale scalars or a position subtotal',()=>{
 render(<BrokerMirrorsSection/>);
 expect(screen.getByTestId('native-money-balance').textContent).toBe('KWD 9,007,199,254,740,993.123');
 expect(screen.getByTestId('native-money-profit').textContent).toBe('KWD -12.345');
 expect(screen.getByTestId('native-money-credit').textContent).toBe('KWD 212.345');
 expect(screen.getByTestId('native-money-equity').textContent).toBe('KWD 1,200.000');
 expect(screen.getByTestId('native-money-margin').textContent).toBe('KWD 0.000');
 expect(screen.getByTestId('native-money-freeMargin').textContent).toBe('KWD 1,200.000');
 expect(screen.getByText(/current state unverified/)).toBeTruthy();
 expect(screen.queryByText(/USD|\$1,000|\$1,005/)).toBeNull();
});
it.each([undefined,null,{...report(),status:'unavailable',amounts:null,reason:'ACCOUNT_REPORT_REJECTED'}])('never falls back when native evidence is absent/rejected',native=>{
 m.query.data.bridges[0].nativeAccountReport=native;render(<BrokerMirrorsSection/>);
 expect(screen.getByTestId('native-money-balance').textContent).toBe('—');
 expect(screen.queryByText(/USD|\$1,000/)).toBeNull();
});
it('fresh bridge telemetry does not rename a stale report as current money',()=>{
 m.query.data.bridges[0].nativeAccountReport.observationAgeMs=180000;render(<BrokerMirrorsSection/>);
 expect(screen.getByText(/Stale report/)).toBeTruthy();expect(screen.getByText(/not account-money freshness/)).toBeTruthy();
});
it('replaces monetary values from a later report and hides cached values on refresh failure',()=>{
 const view=render(<BrokerMirrorsSection/>);m.query.data.bridges[0].nativeAccountReport.amounts.profit='-22.456';view.rerender(<BrokerMirrorsSection/>);
 expect(screen.getByTestId('native-money-profit').textContent).toBe('KWD -22.456');m.query.isError=true;view.rerender(<BrokerMirrorsSection/>);
 expect(screen.queryByTestId('native-money-profit')).toBeNull();expect(screen.getByTestId('mirrors-error')).toBeTruthy();
});
it('overview preserves per-account native reports without mixed-currency totals',()=>{
 const second=bridge();second.bridgeConnectionId=8;second.connectionName='Account B';second.nativeAccountReport.currency='USD';second.nativeAccountReport.amounts.profit='3.000';m.query.data.bridges.push(second);
 render(<OverviewSection/>);
 expect(screen.getAllByTestId('native-money-profit').map(x=>x.textContent)).toEqual(['KWD -12.345','USD 3.000']);
 expect(within(screen.getByTestId('kpi-broker-equity')).getByText('Unavailable')).toBeTruthy();
 expect(within(screen.getByTestId('kpi-open-exposure')).getByText('Unavailable')).toBeTruthy();
});
it('recorded position P/L has no invented dollar currency or forced rounding',()=>{
 m.query.data.openPositions=[{bridgeConnectionId:7,brokerTicket:'fixture',symbol:'EURUSD',floatingPl:-12.345,allocationStatus:null}];
 render(<BrokerMirrorsSection/>);const row=screen.getByTestId('position-fixture');expect(row.textContent).toContain('-12.345');expect(row.textContent).not.toContain('$');
});
