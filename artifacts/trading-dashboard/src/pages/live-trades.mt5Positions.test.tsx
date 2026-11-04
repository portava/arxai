// Regression: Live Trades rendered "MT5 Positions (N)" straight from
// GET /mt5/state, whose positions come from the single platform-wide
// mt5_state row. Any user's EA writes that row through POST
// /mt5/sync-positions and nothing clears it when the heartbeat goes offline,
// so a viewer saw a 20-hour-old snapshot as current, with no push time, a
// missing profit printed as "0.00", and nothing saying the list is not
// scoped to their account.
//
// The page no longer reads GET /mt5/state at all (your own positions come
// from the per-user Open Trades panel), so in every bridge state none of the
// platform-wide snapshot's positions may appear.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let mt5State: Record<string, unknown> | undefined;
const mt5StateReads = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetOpenTrades: () => ({ data: [], isLoading: false }),
  useGetMt5State: () => { mt5StateReads(); return { data: mt5State }; },
  getGetOpenTradesQueryKey: () => ["open"],
  getGetMt5StateQueryKey: () => ["mt5"],
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLoading: false, isError: false, envelope: { currentAccountMode: "PAPER" },
    isLiveShared: false, isDemo: false, isPaper: true, cleanModeLabel: "Paper",
  }),
}));
vi.mock("@/components/LiveTradeCard", () => ({ LiveTradeCard: () => null }));
vi.mock("@/components/live/LiveSlotSummaryCard", () => ({ LiveSlotSummaryCard: () => null }));
vi.mock("@/components/live/LiveOpenTradesPanel", () => ({ LiveOpenTradesPanel: () => null }));
vi.mock("@/components/aaci/AaciSyncChip", () => ({ AaciSyncChip: () => null }));
vi.mock("@/components/live/LiveBridgeAutoRefreshControl", () => ({ LiveBridgeAutoRefreshControl: () => null }));
vi.mock("@/hooks/useLiveBridgeRefresh", () => ({ useLiveBridgeRefresh: () => ({ autoRefreshEnabled: false }) }));

const { default: LiveTrades } = await import("./live-trades");

const twentyHoursAgo = new Date(Date.now() - 20 * 3600_000).toISOString();
const positions = [
  { ticket: 1001, symbol: "EURUSD", side: "BUY", lot: 0.1, entry: 1.08, profit: null },
  { ticket: 1002, symbol: "GBPUSD", side: "SELL", lot: 0.2, entry: 1.27, profit: 5 },
  { ticket: 1003, symbol: "XAUUSD", side: "BUY", lot: 0.01, entry: 2400, profit: -3 },
  { ticket: 1004, symbol: "USDJPY", side: "SELL", lot: 0.3, entry: 150, profit: 1 },
];

afterEach(() => cleanup());

function expectNoPlatformSnapshot() {
  expect(screen.queryByText(/MT5 Positions/)).toBeNull();
  for (const p of positions) expect(screen.queryByText(new RegExp(`#${p.ticket}`))).toBeNull();
  expect(screen.queryByTestId("mt5-positions-card")).toBeNull();
  expect(mt5StateReads).not.toHaveBeenCalled();
}

describe("live-trades MT5 positions card", () => {
  it("does not list an offline bridge's old snapshot as current positions", () => {
    mt5State = { connected: false, positions, lastHeartbeatAt: twentyHoursAgo, lastSyncAt: twentyHoursAgo };
    render(<LiveTrades />);
    expectNoPlatformSnapshot();
  });

  it("does not list the platform-wide snapshot as the viewer's positions even when the bridge is online", () => {
    mt5State = { connected: true, positions, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: "2026-10-28T05:00:00.000Z" };
    render(<LiveTrades />);
    expectNoPlatformSnapshot();
    // A missing profit is never printed as a zero.
    expect(document.body.textContent).not.toContain("0.00");
  });

  it("does not list a snapshot with an unknown push time", () => {
    mt5State = { connected: true, positions, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: null };
    render(<LiveTrades />);
    expectNoPlatformSnapshot();
  });
});
