// Live Trades header: GET /mt5/state is the platform singleton that any
// user's EA heartbeat overwrites (account, liveAllowed, positions). The page
// rendered it as "System MT5 Connected • <account>" and a LIVE/DEMO badge, so
// a PAPER user saw another tenant's account number and a red LIVE badge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let mt5State: Record<string, unknown> | undefined;
let openTrades: unknown[] = [];
let tradingMode: Record<string, unknown>;

vi.mock("@workspace/api-client-react", () => ({
  useGetOpenTrades: () => ({ data: openTrades, isLoading: false }),
  getGetOpenTradesQueryKey: () => ["open-trades"],
  useGetMt5State: () => ({ data: mt5State }),
  getGetMt5StateQueryKey: () => ["mt5-state"],
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => tradingMode }));
vi.mock("@/hooks/useLiveBridgeRefresh", () => ({
  useLiveBridgeRefresh: () => ({
    autoRefreshEnabled: false, toggleAutoRefresh: vi.fn(), refreshNow: vi.fn(), isRefreshing: false,
    lastRefreshAt: null, nextRefreshInMs: null, bridgeState: "offline",
  }),
}));
vi.mock("@/components/live/LiveSlotSummaryCard", () => ({ LiveSlotSummaryCard: () => null }));
vi.mock("@/components/live/LiveOpenTradesPanel", () => ({ LiveOpenTradesPanel: () => <div data-testid="live-open-trades-panel">Open Trades (2)</div> }));
vi.mock("@/components/aaci/AaciSyncChip", () => ({ AaciSyncChip: () => null }));
vi.mock("@/components/live/LiveBridgeAutoRefreshControl", () => ({ LiveBridgeAutoRefreshControl: () => null }));
vi.mock("@/components/LiveTradeCard", () => ({ LiveTradeCard: () => <div data-testid="legacy-trade-card" /> }));

const { default: LiveTrades } = await import("./live-trades");

const PAPER_MODE = {
  isLoading: false, isError: false, envelope: { currentAccountMode: "PAPER" },
  isLiveShared: false, isDemo: false, isPaper: true, cleanModeLabel: "Paper",
};

beforeEach(() => {
  openTrades = [];
  tradingMode = { ...PAPER_MODE };
  mt5State = {
    connected: true, heartbeatFreshness: "degraded", account: "5551234", liveAllowed: true,
    positions: [{ ticket: 77, symbol: "XAUUSD", side: "BUY", lot: 1, entry: 2380, profit: 120 }],
  };
});
afterEach(cleanup);

describe("Live Trades header scope", () => {
  it("another tenant's singleton account and LIVE flag are not shown as the viewer's", () => {
    render(<LiveTrades />);
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("5551234");
    expect(body).not.toContain("System MT5 Connected");
    expect(screen.getByTestId("live-trades-mode").textContent).toBe("PAPER");
    expect(body).not.toContain("#77");
  });

  it("the mode badge follows the viewer's own envelope", () => {
    tradingMode = { ...PAPER_MODE, isLiveShared: true, isPaper: false, envelope: { currentAccountMode: "LIVE_SHARED" } };
    mt5State = { connected: false, liveAllowed: false, positions: [] };
    render(<LiveTrades />);
    expect(screen.getByTestId("live-trades-mode").textContent).toBe("LIVE");
  });
});
