import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// /api/mt5/status returns a literal empty openPositions list: it reads the
// connection row only, never the broker's positions, and says so with
// openPositionsMeasured false. The page used to turn that into "Open Trades 0"
// and invent "Account snapshot synced" / "Position sync completed · Success"
// activity rows timestamped at the heartbeat age.

let statusData: Record<string, unknown> = {};

vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => ({ data: statusData, isLoading: false }),
  useGetMeSharedAccountSummary: () => ({ data: null }),
  getGetMt5StatusQueryKey: () => ["mt5-status"],
  getGetMeSharedAccountSummaryQueryKey: () => ["shared-summary"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: () => undefined }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, isFrozen: false, isDemo: true }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("wouter", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

const { default: MT5BridgePage } = await import("./mt5-bridge");

const connected = {
  connected: true, mode: "LIVE_LOCKED", secondsSinceHeartbeat: 3, lastHeartbeatAt: new Date().toISOString(),
  openPositions: [], openPositionsMeasured: false,
  accountSnapshot: { account: "1234567", broker: "QA Broker", balance: 10_000, equity: 10_050, currency: "USD", syncedAt: null },
};

afterEach(cleanup);

describe("MT5 Bridge page — positions and sync rows", () => {
  it("does not show 'Open Trades 0' or a sync 'Success' row when positions were not read", () => {
    statusData = connected;
    render(<MT5BridgePage />);
    expect(screen.queryByText("Position sync completed")).toBeNull();
    expect(screen.queryByText("Success")).toBeNull();
    // No real account sync time: no "Account snapshot synced" row either.
    expect(screen.queryByText("Account snapshot synced")).toBeNull();
    const tile = screen.getByText("Open Trades").parentElement!;
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).not.toMatch(/Open Trades0/);
  });

  it("dates the account snapshot row from its own sync time", () => {
    statusData = { ...connected, accountSnapshot: { ...connected.accountSnapshot, syncedAt: new Date(Date.now() - 120_000).toISOString() } };
    render(<MT5BridgePage />);
    const row = screen.getByText("Account snapshot synced").parentElement!;
    expect(row.textContent).toContain("2 min ago");
  });
});
