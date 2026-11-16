// /live-trades — the slot card and the Open Trades panel read the same
// response. A fresh bridge heartbeat (isLive) with no recent complete positions
// sweep (positionSyncIncomplete) is not a live book: neither card may say "Live"
// or "live floating P/L" for it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveSlotSummaryCard } from "./LiveSlotSummaryCard";
import { LiveOpenTradesPanel } from "./LiveOpenTradesPanel";

function summary(over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    accountCurrency: "USD", balance: 1000, equity: 1012.5, margin: 10, freeMargin: 1002.5, marginLevelPercent: 10125,
    openPnL: 12.5, isLive: true, isStale: false, positionSyncIncomplete: true,
    snapshotWarning: "Position sync incomplete — waiting for broker confirmation.",
    isAllocated: true, allocationNote: null, lastUpdated: now,
    positions: [{
      brokerTicket: "3001", symbol: "EURUSD", direction: "BUY", volume: 0.1, entryPrice: 1.1, currentPrice: 1.101,
      stopLoss: null, takeProfit: null, grossProfit: 12.5, swap: null, commission: null, netProfit: 12.5,
      profitPercentOfSlot: 1.25, openedAt: now, lastUpdated: now, freshness: "STALE", confirmation: "BROKER_CONFIRMATION_PENDING",
    }],
    ...over,
  };
}

function mount(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LiveSlotSummaryCard />
      <LiveOpenTradesPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("slot card agrees with the open-trades panel on sync-pending", () => {
  it("fresh heartbeat but incomplete positions sweep: no 'Live' on either card", async () => {
    mount(summary());
    await screen.findByTestId("open-trades-badge-sync-pending");
    await screen.findByTestId("slot-summary-card");
    expect(screen.queryByTestId("badge-live")).toBeNull();
    expect(screen.getByTestId("badge-sync-pending")).toBeTruthy();
    expect(screen.getByTestId("slot-summary-card").textContent).not.toContain("live floating P/L");
  });

  it("fresh heartbeat and a complete sweep still reads Live on both", async () => {
    mount(summary({ positionSyncIncomplete: false, snapshotWarning: null }));
    await screen.findByTestId("open-trades-badge-live");
    expect(screen.getByTestId("badge-live")).toBeTruthy();
    expect(screen.getByTestId("slot-summary-card").textContent).toContain("live floating P/L");
  });
});
