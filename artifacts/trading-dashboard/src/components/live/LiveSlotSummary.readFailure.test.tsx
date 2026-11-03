// /live-trades — a failed /me/live/slot-summary read is "could not be loaded",
// never "No open trades right now", "none received" or a cached green "Live".
//
// Both LiveSlotSummaryCard and LiveOpenTradesPanel share one query. Before the
// fix the queryFn parsed any HTTP response as a summary (a 401 envelope became
// an empty book) and neither component read q.isError, so a refetch that failed
// after a good read kept the last "Live" badge and "Current P/L" on screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveSlotSummaryCard } from "./LiveSlotSummaryCard";
import { LiveOpenTradesPanel } from "./LiveOpenTradesPanel";

function goodSummary() {
  const now = new Date().toISOString();
  return {
    accountCurrency: "USD", balance: 1000, equity: 1012.5, margin: 10, freeMargin: 1002.5, marginLevelPercent: 10125,
    openPnL: 12.5, isLive: true, isStale: false, positionSyncIncomplete: false, snapshotWarning: null,
    isAllocated: true, allocationNote: null, lastUpdated: now,
    positions: [{
      brokerTicket: "2001", symbol: "EURUSD", direction: "BUY", volume: 0.1, entryPrice: 1.1, currentPrice: 1.101,
      stopLoss: null, takeProfit: null, grossProfit: 12.5, swap: null, commission: null, netProfit: 12.5,
      profitPercentOfSlot: 1.25, openedAt: now, lastUpdated: now, freshness: "FRESH", confirmation: "BROKER_CONFIRMED",
    }],
  };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LiveSlotSummaryCard />
      <LiveOpenTradesPanel />
    </QueryClientProvider>,
  );
  return qc;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("slot summary read failure", () => {
  it("401 envelope on first read: could not be loaded, not an empty book or 'none received'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), {
      status: 401, headers: { "content-type": "application/json" },
    })));
    mount();
    await screen.findByTestId("open-trades-load-error");
    expect(screen.getByTestId("open-trades-load-error").textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByTestId("open-trades-empty")).toBeNull();
    expect(screen.queryByText(/none received/)).toBeNull();
    expect(screen.queryByText(/Disconnected/)).toBeNull();
    expect(screen.getByTestId("open-trades-badge-read-failed")).toBeTruthy();
    await screen.findByTestId("slot-summary-error");
    expect(screen.getByTestId("slot-summary-error").textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByTestId("slot-summary-card")).toBeNull();
  });

  it("HTML 500 on first read: could not be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Internal Server Error</html>", {
      status: 500, headers: { "content-type": "text/html" },
    })));
    mount();
    await screen.findByTestId("open-trades-load-error");
    expect(screen.queryByTestId("open-trades-empty")).toBeNull();
    await screen.findByTestId("slot-summary-error");
  });

  it("a refetch that fails after a good read drops 'Live' and says the data is from the last successful read", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(goodSummary()), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = mount();
    await screen.findByTestId("open-trades-badge-live");
    await screen.findByTestId("badge-live");
    expect(screen.getByTestId("open-trade-mobile-2001").textContent).toContain("Current P/L");

    fetchMock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["live", "slot-summary"] }).catch(() => undefined);
    });

    await waitFor(() => expect(screen.queryByTestId("open-trades-badge-live")).toBeNull());
    expect(screen.queryByTestId("badge-live")).toBeNull();
    expect(screen.getByTestId("open-trades-badge-read-failed")).toBeTruthy();
    expect(screen.getByTestId("badge-read-failed")).toBeTruthy();
    expect(screen.getByTestId("open-trades-refresh-failed").textContent).toMatch(/last successful read/i);
    expect(screen.getByTestId("slot-refresh-failed").textContent).toMatch(/last successful read/i);
    expect(screen.getByTestId("open-trade-mobile-2001").textContent).not.toContain("Current P/L");
    expect(screen.getByTestId("open-trade-mobile-2001").textContent).toContain("Last reported P/L");
    expect(screen.getByTestId("slot-summary-card").textContent).not.toContain("live floating P/L");
  });
});
