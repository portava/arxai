// Trade Command Room panels: a position row the MT5 sync has not refreshed
// recently (route flag `stale`, mapped to status "stale" by the page) must say
// so — not render like a current position with a bare dash for P&L.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { PositionsPanel } from "./TradePanels";

afterEach(cleanup);

describe("PositionsPanel stale rows", () => {
  it("a stale row is labelled stale, not shown as a current position", () => {
    render(<PositionsPanel positions={[{ id: 7, symbol: "EURUSD", side: "BUY", lotSize: 0.1, entry: 1.08, pnl: null, status: "stale" }]} />);
    expect(screen.getByTestId("position-7-stale").textContent).toMatch(/Not refreshed by the MT5 sync recently/);
    expect(screen.getByTestId("position-7-pnl").textContent).toBe("P&L stale");
  });

  it("a fresh row with no P&L says it was not reported", () => {
    render(<PositionsPanel positions={[{ id: 8, symbol: "EURUSD", side: "SELL", lotSize: 0.1, pnl: null }]} />);
    expect(screen.queryByTestId("position-8-stale")).toBeNull();
    expect(screen.getByTestId("position-8-pnl").textContent).toBe("P&L not reported");
  });

  it("a fresh row with P&L shows the number", () => {
    render(<PositionsPanel positions={[{ id: 9, symbol: "EURUSD", side: "BUY", lotSize: 0.1, pnl: 12.5 }]} />);
    expect(screen.getByTestId("position-9-pnl").textContent).toBe("+12.50");
  });
});
