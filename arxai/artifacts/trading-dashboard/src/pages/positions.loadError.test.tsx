// Regression: Positions load() had no error path. When a poll failed the last
// simulator book and stat tiles stayed on screen as current with no word of
// the failure, a failed first load read "No open positions yet.", and a JSON
// error body for the P&L summary rendered tiles as "$undefined".
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

const { default: PositionsPage } = await import("./positions");

const PNL = { environment: "ALL", dailyPnL: 5, weeklyPnL: 7, monthlyPnL: 9, openUnrealizedPnL: 1.5, closedRealizedPnL: 3, wins: 1, losses: 0, winRate: 100, averageR: 1, maxDrawdown: 0 };
const POS = {
  positionId: "pos_1", orderId: "ord_1", environment: "DEMO_SIMULATOR", symbol: "EURUSD", direction: "BUY", lotSize: 0.1,
  entryPrice: 1.085, currentPrice: 1.086, unrealizedPnL: 1.5, realizedPnL: 0, rMultiple: 0.1, status: "OPEN",
  openedAt: "2026-10-28T09:00:00.000Z", currentPriceBasis: "SIMULATOR_QUOTE", currentPriceAsOf: "2026-10-28T09:00:00.000Z",
};
const ok = (url: string) => new Response(JSON.stringify(String(url).includes("/api/oms/positions") ? { positions: [POS] } : PNL), { status: 200 });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Positions load failure truth", () => {
  it("says the book is a cached copy when a later poll fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/oms/positions")) round += 1;
      if (round > 1) throw new TypeError("Failed to fetch");
      return ok(url);
    }));
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    expect(screen.queryByTestId("positions-load-error")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(screen.getByTestId("positions-load-error").textContent)
      .toMatch(/Could not refresh positions \(Failed to fetch\)\. Showing the book as last loaded at .*; it may have changed since\./));
  });

  it("a failed first load is an error, not 'No open positions yet.'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByTestId("positions-load-error").textContent).toMatch(/Positions could not be loaded \(positions HTTP 500\)/));
    expect(screen.queryByText("No open positions yet.")).toBeNull();
  });

  it("an error body for the P&L summary never renders as $undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("/api/pnl/summary")
      ? new Response(JSON.stringify({ error: "x" }), { status: 200 })
      : ok(url)));
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/undefined/);
    expect(screen.getByTestId("positions-pnl-unavailable").textContent).toMatch(/P&L summary unavailable/);
  });
});
