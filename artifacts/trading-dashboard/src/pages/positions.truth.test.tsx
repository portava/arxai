// Positions page — says it is the user's SIMULATOR book, and shows every
// realized dollar on an open position.
//
// Before: the page dropped the response's `dataSource: "SIMULATOR"`, so
// nothing on screen said "simulator"; the empty state promised "Your
// positions will appear here once you place a trade". An open position with a
// ½ close showed only its unrealized P/L (e.g. "$0", coloured red because the
// colour test fell through to the realized -12.5) and the realized -12.50 was
// nowhere on the card. A failed read rendered "No open positions yet."

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { default: PositionsPage } = await import("./positions");

const openWithPartial = {
  positionId: "pos_1", orderId: "ord_1", environment: "PAPER", symbol: "EURUSD", direction: "BUY", lotSize: 0.05,
  entryPrice: 1.085, currentPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095,
  unrealizedPnL: 0, realizedPnL: -12.5, rMultiple: 0, status: "OPEN", openedAt: new Date().toISOString(),
  dataSource: "SIMULATOR",
};
const pnl = {
  environment: "ALL", dailyPnL: -12.5, weeklyPnL: -12.5, monthlyPnL: -12.5, openUnrealizedPnL: 0, closedRealizedPnL: -12.5,
  wins: 0, losses: 0, winRate: 0, averageR: 0, maxDrawdown: 0, dataSource: "SIMULATOR",
};

function stubFetch(routes: Record<string, () => Promise<Response> | Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key]!();
  }));
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Positions page — simulator source", () => {
  it("names the SIMULATOR data source and never calls the list 'your positions' from a broker", async () => {
    stubFetch({ "/api/oms/positions": () => json({ positions: [openWithPartial], dataSource: "SIMULATOR" }), "/api/pnl/summary": () => json(pnl) });
    render(<PositionsPage />);
    await screen.findByText("EURUSD");
    expect(screen.getByTestId("positions-data-source").textContent).toMatch(/SIMULATOR/);
    expect(document.body.textContent).toMatch(/not a broker/i);
  });

  it("the empty state says the user's simulator book is empty, not that positions will appear 'once you place a trade'", async () => {
    stubFetch({ "/api/oms/positions": () => json({ positions: [], dataSource: "SIMULATOR" }), "/api/pnl/summary": () => json(pnl) });
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByTestId("positions-data-source").textContent).toMatch(/SIMULATOR/));
    expect(document.body.textContent).not.toMatch(/Your positions will appear here once you place a trade/);
    expect(document.body.textContent).toMatch(/No open simulator positions/i);
  });

  it("a failed read says it could not load, never 'No open positions'", async () => {
    stubFetch({ "/api/oms/positions": () => json({ error: "boom" }, 500), "/api/pnl/summary": () => json({ error: "boom" }, 500) });
    render(<PositionsPage />);
    await screen.findByText(/positions could not be loaded/i);
    expect(screen.queryByText(/No open/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$undefined/);
  });
});

describe("Positions page — realized P/L on an open position", () => {
  it("shows the realized amount from a partial close next to the unrealized P/L", async () => {
    stubFetch({ "/api/oms/positions": () => json({ positions: [openWithPartial], dataSource: "SIMULATOR" }), "/api/pnl/summary": () => json(pnl) });
    render(<PositionsPage />);
    await screen.findByText("EURUSD");
    const pnlCell = screen.getByTestId("position-pnl-pos_1");
    expect(pnlCell.textContent).toMatch(/Unrealized\s*\$0\.00/);
    expect(pnlCell.textContent).toMatch(/Realized\s*-\$12\.50/);
  });
});
