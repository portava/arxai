import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveOpenTradesPanel } from "./LiveOpenTradesPanel";

/**
 * Truth guard: a fresh bridge HEARTBEAT is not a fresh POSITIONS snapshot.
 * When the server reports positionSyncIncomplete the panel must not show a
 * green "Live" badge, must show the snapshot warning, must mark the row as
 * confirmation-pending, and must never render an unreported P/L as $0.00.
 */

const twoMinAgo = new Date(Date.now() - 120_000).toISOString();

function payload(overrides: Record<string, unknown> = {}, row: Record<string, unknown> = {}) {
  return {
    accountCurrency: "USD",
    isLive: true,
    isStale: false,
    positionSyncIncomplete: true,
    snapshotWarning: "Position sync incomplete — waiting for broker confirmation.",
    lastUpdated: new Date().toISOString(),
    positions: [
      {
        brokerTicket: "1001",
        symbol: "EURUSD",
        direction: "BUY",
        volume: 0.1,
        entryPrice: 1.1,
        currentPrice: 1.101,
        stopLoss: null,
        takeProfit: null,
        grossProfit: null,
        swap: null,
        commission: null,
        netProfit: null,
        profitPercentOfSlot: null,
        openedAt: twoMinAgo,
        lastUpdated: twoMinAgo,
        freshness: "STALE",
        confirmation: "BROKER_CONFIRMATION_PENDING",
        ...row,
      },
    ],
    ...overrides,
  };
}

function mount(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LiveOpenTradesPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LiveOpenTradesPanel truth", () => {
  it("heartbeat fresh but snapshot incomplete: no Live badge, warning shown, row pending, P/L not $0.00", async () => {
    mount(payload());
    await screen.findByTestId("open-trade-1001");
    expect(screen.queryByTestId("open-trades-badge-live")).toBeNull();
    expect(screen.getByTestId("open-trades-badge-sync-pending")).toBeTruthy();
    expect(screen.getByTestId("open-trades-sync-incomplete").textContent).toContain(
      "Position sync incomplete",
    );
    const panel = screen.getByTestId("live-open-trades-panel");
    expect(panel.textContent).not.toContain("$0.00");
    expect(panel.textContent).not.toContain("Live floating P/L");
    expect(screen.getByTestId("open-trade-pl-1001").textContent).toBe("Not reported");
    expect(screen.getByTestId("open-trade-mobile-pl-1001").textContent).toContain("Not reported");
    expect(screen.getByTestId("open-trade-updated-1001").textContent).toContain("unconfirmed");
    expect(screen.getByTestId("open-trade-mobile-pending-1001").textContent).toMatch(
      /Broker confirmation pending — last reported by the bridge at/,
    );
  });

  it("fresh heartbeat AND reliable snapshot with a confirmed row reads Live with the reported P/L", async () => {
    mount(
      payload(
        { positionSyncIncomplete: false, snapshotWarning: null },
        { netProfit: 12.5, grossProfit: 12.5, freshness: "FRESH", confirmation: "BROKER_CONFIRMED", lastUpdated: new Date().toISOString() },
      ),
    );
    await screen.findByTestId("open-trade-1001");
    expect(screen.getByTestId("open-trades-badge-live")).toBeTruthy();
    expect(screen.queryByTestId("open-trades-sync-incomplete")).toBeNull();
    expect(screen.getByTestId("open-trade-pl-1001").textContent).toBe("+$12.50");
    expect(screen.getByTestId("open-trade-updated-1001").textContent).not.toContain("unconfirmed");
  });
});
