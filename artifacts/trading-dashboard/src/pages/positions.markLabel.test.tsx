// Regression: the Positions card labelled every currentPrice "Now" — including
// a closed position's stop/target exit price and a mark the simulator could
// not refresh (no quote) — with no time.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const { default: PositionsPage } = await import("./positions");

const PNL = { environment: "ALL", dailyPnL: 0, weeklyPnL: 0, monthlyPnL: 0, openUnrealizedPnL: 0, closedRealizedPnL: -20, wins: 0, losses: 1, winRate: 0, averageR: -1, maxDrawdown: 20 };
function pos(over: Record<string, unknown>) {
  return {
    positionId: "pos_1", orderId: "ord_1", environment: "DEMO_SIMULATOR", symbol: "EURUSD", direction: "BUY", lotSize: 0.1,
    entryPrice: 1.085, currentPrice: 1.08, stopLoss: 1.08, takeProfit: 1.1, unrealizedPnL: 0, realizedPnL: -50, rMultiple: -1,
    status: "STOPPED_OUT", openedAt: "2026-10-28T09:00:00.000Z", closedAt: "2026-10-28T10:00:00.000Z", closeReason: "STOPPED_OUT",
    currentPriceBasis: "EXIT_PRICE", currentPriceAsOf: "2026-10-28T10:00:00.000Z", ...over,
  };
}
function stub(positions: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    String(url).includes("/api/oms/positions") ? { positions, dataSource: "SIMULATOR" } : PNL,
  ), { status: 200 })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Positions card price label truth", () => {
  it("labels a stopped-out card's price as the exit price, not Now", async () => {
    stub([pos({})]);
    render(<PositionsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    await waitFor(() => expect(screen.getByText("Stopped out")).toBeTruthy());
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.getByText("Exit")).toBeTruthy();
  });

  it("says an open position's price is a stale mark when the simulator had no quote", async () => {
    stub([pos({ status: "OPEN", closedAt: undefined, closeReason: undefined, currentPrice: 1.085, currentPriceBasis: "NO_QUOTE", currentPriceAsOf: "2026-10-28T09:00:00.000Z" })]);
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.getByText("Last mark")).toBeTruthy();
    expect(screen.getByText(/no simulator quote since/)).toBeTruthy();
  });

  it("an open position marked from a simulator quote is Now, with the quote time", async () => {
    stub([pos({ status: "OPEN", closedAt: undefined, closeReason: undefined, currentPriceBasis: "SIMULATOR_QUOTE", currentPriceAsOf: new Date().toISOString() })]);
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByText("Now")).toBeTruthy());
    expect(screen.getByText(/sim quote /)).toBeTruthy();
  });
});
