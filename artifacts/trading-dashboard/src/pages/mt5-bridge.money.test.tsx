import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import MT5BridgePage from './mt5-bridge';
vi.mock('@/hooks/useLiveAccountSnapshot', () => ({ useLiveAccountSnapshot: () => ({}) }));
const h = vi.hoisted(() => ({ status: {} as any, summaryReads: 0 }));
vi.mock('@workspace/api-client-react', async original => ({
  ...await original<typeof import('@workspace/api-client-react')>(),
  useGetMt5Status: () => h.status,
  useGetMeSharedAccountSummary: () => { h.summaryReads++; return { data: { balance: 4444, equity: 5555, pnl: 6666, masterAccess: true, masterMt5: { nativeAccountReport: { amounts: { balance: '999999.000' } } } } }; },
}));
vi.mock('@tanstack/react-query', async original => ({ ...await original<typeof import('@tanstack/react-query')>(), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@/hooks/useTradingMode', () => ({ useTradingMode: () => ({ isLoading: false, isFrozen: false, userAllocation: 1234.567 }) }));
vi.mock('@/lib/assistant-name', () => ({ useAssistantName: () => ({ name: 'Eleanor' }) }));
const NOW = Date.parse('2026-11-01T12:00:00Z');
const report = () => ({ status: 'reported', currentVerified: false, reason: 'CLOCK_AND_CONTINUITY_UNVERIFIED',
  observedAt: new Date(NOW - 2000).toISOString(), receivedAt: new Date(NOW - 1000).toISOString(), currency: 'KWD', currencyDigits: 3,
  amounts: { balance: '9007199254740993.123', equity: '0.000', profit: '-7.125', credit: '4.000', margin: '0.000', freeMargin: '0.000' } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); h.summaryReads = 0; h.status = { isLoading: false, isError: false,
  data: { connected: true, secondsSinceHeartbeat: 1, accountSnapshot: { account: '12345678', broker: 'Personal fixture', balance: 1111, equity: 2222, freeMargin: 3333, currency: 'USD' }, nativeAccountReport: report(), openPositions: [] } }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('uses only the personal native report, with exact precision and direct account profit', () => {
  render(<MT5BridgePage/>);
  expect(screen.getByTestId('native-money-balance').textContent).toBe('KWD 9,007,199,254,740,993.123');
  expect(screen.getByTestId('native-money-equity').textContent).toBe('KWD 0.000');
  expect(screen.getByTestId('native-money-profit').textContent).toBe('KWD -7.125');
  expect(h.summaryReads).toBe(0); expect(screen.queryByText(/1,111|2,222|3,333|4,444|5,555|6,666|999999/)).toBeNull();
  expect(within(screen.getByTestId('native-account-report')).getByText(/current state unverified/)).toBeTruthy();
});
it.each([undefined, null, { status: 'unavailable', reason: 'ACCOUNT_REPORT_REJECTED', amounts: null }])('missing/rejected report %j cannot fall back to legacy or master money', value => {
  h.status.data.nativeAccountReport = value; render(<MT5BridgePage/>);
  expect(screen.getByTestId('native-money-balance').textContent).toBe('—'); expect(screen.queryByText(/1,111|2,222|4,444|5,555/)).toBeNull();
});
it('failed status refresh with cached connected report withholds money and active connection claim', () => {
  h.status.isError = true; render(<MT5BridgePage/>);
  expect(screen.getByTestId('native-money-profit').textContent).toBe('—'); expect(screen.getByText(/latest account refresh failed/)).toBeTruthy();
  expect(screen.queryByText(/^Connected$/)).toBeNull(); expect(screen.queryByText(/^Active$/)).toBeNull();
});
it('fresh heartbeat alone cannot claim active monetary updates', () => {
  h.status.data.nativeAccountReport = null; render(<MT5BridgePage/>);
  const row = screen.getByText('Account Refresh').parentElement!;
  expect(within(row).queryByText('Active')).toBeNull(); expect(row.textContent).toMatch(/unverified|report below/i);
  expect(screen.queryByText('Account snapshot synced')).toBeNull();
});
it('same report becomes stale without a fetch and cannot be renewed by a heartbeat', () => {
  const view = render(<MT5BridgePage/>); act(() => vi.advanceTimersByTime(125000));
  h.status.data = { ...h.status.data, secondsSinceHeartbeat: 0 }; view.rerender(<MT5BridgePage/>);
  expect(screen.getByText(/Stale report/)).toBeTruthy(); expect(screen.getByTestId('native-money-profit').textContent).toBe('KWD -7.125');
});
it('report removal after connection switch cannot retain previous account money', () => {
  const view = render(<MT5BridgePage/>); h.status.data = { ...h.status.data, nativeAccountReport: null, accountSnapshot: { account: '87654321', broker: 'Other personal fixture', balance: 7777 } }; view.rerender(<MT5BridgePage/>);
  expect(screen.getByTestId('native-money-balance').textContent).toBe('—'); expect(screen.queryByText(/9,007,199|7,777/)).toBeNull();
});

it('allocation records do not borrow a broker currency and empty legacy positions do not claim a sync', () => {
  render(<MT5BridgePage/>);
  expect(screen.getAllByText('1234.567').length).toBeGreaterThan(0);
  expect(screen.queryByText(/\$1,234|KWD 1,234/)).toBeNull();
  expect(screen.getByText(/Allocation is an ARX ledger record/)).toBeTruthy();
  expect(screen.queryByText('Position sync completed')).toBeNull();
  expect(screen.queryByText('Open Trades')).toBeNull();
});
