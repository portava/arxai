// Live Open Trades / slot summary — a position whose P/L the broker has not
// reported is "Not reported", never "$0.00", and a row the broker has not
// re-confirmed carries the server's stale / pending marker instead of a
// coloured live P/L. The slot card shows "—" for open P/L / equity when the
// server reports them unknown.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveOpenTradesPanel } from "./LiveOpenTradesPanel";
import { LiveSlotSummaryCard } from "./LiveSlotSummaryCard";

const row = {
  brokerTicket: "5002", symbol: "EURUSD", direction: "BUY", volume: 0.1, entryPrice: 1.1, currentPrice: null,
  stopLoss: null, takeProfit: null, grossProfit: null, swap: null, commission: null, netProfit: null,
  profitPercentOfSlot: null, openedAt: null, lastUpdated: new Date(Date.now() - 40 * 60_000).toISOString(),
  freshness: "STALE", confirmation: "BROKER_CONFIRMATION_PENDING",
};
const body = {
  accountCurrency: "USD", balance: 1000, equity: null, margin: 10, freeMargin: null, marginLevelPercent: null,
  openPnL: null, unpricedPositionCount: 1, positions: [row], isLive: false, isStale: true, isAllocated: true,
  allocationNote: null, lastUpdated: row.lastUpdated,
};

function wrap(node: React.ReactNode) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("unreported / unconfirmed position P/L", () => {
  it("panel: no $0.00, a pending marker, and the column is not labelled Net", async () => {
    wrap(<LiveOpenTradesPanel />);
    await waitFor(() => expect(screen.getByTestId("open-trade-pl-5002")).toBeTruthy());
    expect(screen.getByTestId("open-trade-pl-5002").textContent).toBe("Not reported");
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("+$0.00")).toBeNull();
    expect(screen.getAllByTestId("open-trade-pending-5002").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("open-trade-pending-5002")[0]!.textContent).toMatch(/awaiting broker confirmation/);
    expect(screen.queryByText("Net P/L")).toBeNull();
  });

  it("card: open P/L and equity are '—' with the reason", async () => {
    wrap(<LiveSlotSummaryCard />);
    await waitFor(() => expect(screen.getByTestId("slot-pnl-unreported")).toBeTruthy());
    expect(screen.getByTestId("slot-pnl-unreported").textContent).toMatch(/not reported P\/L for 1 open position/);
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.getByText("Open P/L").parentElement!.textContent).toContain("—");
    expect(screen.getByText("Slot Equity").parentElement!.textContent).toContain("—");
  });
});
