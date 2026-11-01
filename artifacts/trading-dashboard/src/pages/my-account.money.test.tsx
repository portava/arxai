import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import MyAccountPage from "./my-account";

const h = vi.hoisted(() => ({ shell: {} as any, live: {} as any }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[1] === "account-shell" ? h.shell : { isLoading: true },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({}) }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => h.live }));
vi.mock("@/components/mt5/OneClickToggleCard", () => ({ OneClickToggleCard: () => <div data-testid="existing-one-click-control"/> }));
vi.mock("@/lib/perf", () => ({ markActionStart: () => "test", markActionEnd: vi.fn(), markUiFeedback: vi.fn(), markRenderComplete: vi.fn(), markApiStart: vi.fn(), markApiEnd: vi.fn() }));

beforeEach(() => {
  h.shell = { data: { ok: true, userId: 1, accountMode: "SHARED_MASTER_MT5", approvalStatus: "APPROVED", tradingStatus: "ACTIVE",
    allocation: { assignedStartingBalance: 1000, currentBalance: 1050, equity: 1050, marginUsed: 12, totalAllocation: 1000, manualAllocation: 1000, aiSleeveAllocation: 0, availableCapacity: 988 },
    pnl: { openPnl: 50, closedPnlToday: 5, closedPnlWeek: 10, closedPnlTotal: 20, tradesToday: 1, winsToday: 1, lossesToday: 0 },
    risk: { availableRiskAmount: null, dailyLossRemaining: null, openExposureLots: 0, maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, maxExposurePerSymbolLots: null, allowedSymbols: null, requireStopLoss: true },
    notes: { needsReviewItems: 0, sharedMasterAccountAssigned: true },
  }, isLoading: false, error: null };
  h.live = { autoRefreshEnabled: true, live: { allocatedBalance: 1000, liveEquity: 9999, availableBalance: 8888, floatingPnL: 50, realizedPnL: 20, realizedPnLPendingCount: 0, marginUsed: 12, freeMargin: 988, openTradeCount: 1,
    monetaryScopeVerified: false, positionPnlComplete: true, positionPnlEstimated: false,
    freshness: { status: "fresh", lastUpdatedAt: new Date().toISOString(), ageMs: 0 } } };
});
afterEach(cleanup);

it("does not reintroduce shell-derived broker equity beside a withheld canonical allocation", () => {
  render(<MyAccountPage/>);
  expect(screen.getByText(/Derived allocation figures are unavailable/)).toBeTruthy();
  expect(screen.queryByTestId("my-equity")).toBeNull();
  expect(screen.queryByTestId("my-balance")).toBeNull();
  expect(screen.queryByTestId("my-margin-used")).toBeNull();
  expect(screen.queryByText(/1,050/)).toBeNull();
  expect(screen.getByText("Recorded allocation settings")).toBeTruthy();
});
it.each(["PERSONAL_MT5", "DEMO"])("identifies %s shell open P/L as paper results, never broker account profit", mode => {
  h.shell.data.accountMode = mode; h.shell.data.pnl.openPnl = 777.123;
  render(<MyAccountPage/>);
  expect(screen.getByText("Recorded paper open P/L")).toBeTruthy();
  expect(screen.getByTestId("my-pnl-open").textContent).toContain("777.123");
  expect(screen.getByTestId("my-pnl-open").textContent).not.toContain("$");
  expect(screen.queryByText(/^Open P\/L$/)).toBeNull();
  expect(screen.getByTestId("my-broker-money-unavailable").textContent).toMatch(/not available in this view/);
});
it("identifies shared P/L as a stored allocation record, not a complete account observation", () => {
  render(<MyAccountPage/>);
  expect(screen.getByText("Recorded allocation P/L")).toBeTruthy();
  expect(screen.getByText(/currency and broker agreement are unverified/i)).toBeTruthy();
});
it("missing assigned allocation cannot borrow shell current balance", () => {
  h.shell.data.allocation.assignedStartingBalance = null;
  render(<MyAccountPage/>);
  expect(screen.getByTestId("my-allocation").textContent).toContain("—");
  expect(screen.getByTestId("my-allocation").textContent).not.toContain("1,050");
});
it("preserves genuine recorded zero and fractional precision without assigning a currency", () => {
  h.shell.data.allocation.assignedStartingBalance = 0; h.shell.data.pnl.openPnl = 0.0001;
  render(<MyAccountPage/>);
  expect(screen.getByTestId("my-allocation").textContent).toContain("0");
  expect(screen.getByTestId("my-allocation").textContent).not.toMatch(/[$—]/);
  expect(screen.getByTestId("my-pnl-open").textContent).toContain("0.0001");
});
it.each([NaN, Infinity, null])("unknown/nonfinite recorded P/L %s remains unavailable", value => {
  h.shell.data.pnl.openPnl = value;
  render(<MyAccountPage/>);
  expect(screen.getByTestId("my-pnl-open").textContent).toContain("—");
  expect(screen.getByTestId("my-pnl-open").textContent).not.toMatch(/NaN|Infinity|\$0/);
});
it("a failed shell refresh does not leave cached personal money displayed", () => {
  h.shell.error = Error("offline");render(<MyAccountPage/>);
  expect(screen.queryByTestId("my-account-page")).toBeNull();
  expect(screen.getByText(/Could not load your account view/)).toBeTruthy();
});
it("retains risk restrictions and existing trading controls", () => {
  render(<MyAccountPage/>);
  expect(within(screen.getByTestId("my-require-sl")).getByText("Yes")).toBeTruthy();
  expect(screen.getByTestId("existing-one-click-control")).toBeTruthy();
});
