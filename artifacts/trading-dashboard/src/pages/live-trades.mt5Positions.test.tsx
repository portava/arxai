// Regression: Live Trades rendered "MT5 Positions (N)" straight from
// GET /mt5/state, whose positions come from the single platform-wide
// mt5_state row. Any user's EA writes that row through POST
// /mt5/sync-positions and nothing clears it when the heartbeat goes offline,
// so a viewer saw a 20-hour-old snapshot as current, with no push time, a
// missing profit printed as "0.00", and nothing saying the list is not
// scoped to their account.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let mt5State: Record<string, unknown> | undefined;

vi.mock("@workspace/api-client-react", () => ({
  useGetOpenTrades: () => ({ data: [], isLoading: false }),
  useGetMt5State: () => ({ data: mt5State }),
  getGetOpenTradesQueryKey: () => ["open"],
  getGetMt5StateQueryKey: () => ["mt5"],
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

describe("live-trades MT5 positions card", () => {
  it("does not list an offline bridge's old snapshot as current positions", () => {
    mt5State = { connected: false, positions, lastHeartbeatAt: twentyHoursAgo, lastSyncAt: twentyHoursAgo };
    render(<LiveTrades />);
    expect(screen.queryByText(/MT5 Positions \(4\)/)).toBeNull();
    expect(screen.queryByText(/#1001/)).toBeNull();
    const note = screen.getByTestId("mt5-positions-stale");
    expect(note.textContent).toMatch(/offline/i);
    expect(note.textContent).toMatch(/not current/i);
    expect(note.textContent).toMatch(/4 positions/);
  });

  it("when online, states the push time and that the snapshot is platform-wide; missing profit is not 0.00", () => {
    mt5State = { connected: true, positions, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: "2026-10-28T05:00:00.000Z" };
    render(<LiveTrades />);
    const card = screen.getByTestId("mt5-positions-card");
    expect(card.textContent).toMatch(/not filtered to your account/i);
    expect(card.textContent).toMatch(/last pushed/i);
    const row = screen.getByText(/#1001/).parentElement!;
    expect(row.textContent).not.toContain("0.00");
    expect(row.textContent).toContain("—");
  });

  it("says the push time is unknown when lastSyncAt is missing", () => {
    mt5State = { connected: true, positions, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: null };
    render(<LiveTrades />);
    expect(screen.getByTestId("mt5-positions-card").textContent).toMatch(/push time unknown/i);
  });
});
