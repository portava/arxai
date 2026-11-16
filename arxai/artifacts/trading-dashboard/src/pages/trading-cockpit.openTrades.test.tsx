// Regression: "Open paper trades" showed the stored paper_orders.profitLoss
// for every open order. That column is written only at close (default 0), so
// each open trade read "P&L 0" as if it had been measured flat. A failed read
// of the open orders also showed "No open paper trades".
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { OpenTradesPanel } from "./trading-cockpit";

afterEach(() => cleanup());

const row = {
  id: 7, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1,
  stopLoss: 1.09, takeProfit: 1.2, status: "OPEN", openedAt: "2026-10-28T09:00:00.000Z",
};

describe("cockpit open paper trades P&L", () => {
  it("an OPEN row's stored 0 (older server) renders as '—', not 0", () => {
    render(<OpenTradesPanel s={{ openPaperTrades: [{ ...row, profitLoss: 0 }] }} />);
    const cell = screen.getByTestId("open-trade-pnl");
    expect(cell.textContent).toBe("—");
    expect(cell.getAttribute("title")).toMatch(/not tracked per open order/);
    expect(screen.getByTestId("open-trade-pnl-note").textContent).toMatch(/recorded when it closes/);
  });

  it("a NOT_MEASURED row from the server renders as '—'", () => {
    render(<OpenTradesPanel s={{ openPaperTrades: [{ ...row, profitLoss: null, profitLossStatus: "NOT_MEASURED" }], openPaperTradesStatus: "LOADED" }} />);
    expect(screen.getByTestId("open-trade-pnl").textContent).toBe("—");
  });

  it("a failed read says it could not be loaded, not 'No open paper trades'", () => {
    render(<OpenTradesPanel s={{ openPaperTrades: [], openPaperTradesStatus: "UNAVAILABLE" }} />);
    expect(screen.getByTestId("open-paper-trades-unavailable").textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText(/No open paper trades/)).toBeNull();
  });
});
