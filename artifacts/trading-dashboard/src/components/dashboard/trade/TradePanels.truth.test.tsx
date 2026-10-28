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

import { OrdersPanel } from "./TradePanels";

describe("OrdersPanel scanner rows", () => {
  const now = Date.parse("2026-10-28T12:00:00.000Z");
  const base = {
    symbol: "EURUSD", timeframe: "M15", recommendedAction: "BUY", confidenceScore: 70,
    opportunity: { score: 82, label: "STRONG" },
    generatedAt: new Date(now - 5_000).toISOString(), dataStatus: "live", tradeable: true, disabledReason: null,
  };
  function renderRows(rows: unknown[]) {
    vi.spyOn(Date, "now").mockReturnValue(now);
    render(<OrdersPanel opps={rows as never} intentCount={0} picked={null} onPick={() => {}} />);
  }
  afterEach(() => vi.restoreAllMocks());

  it("a simulator-only row shows no BUY and no score", () => {
    renderRows([{ ...base, dataStatus: "simulator_only", tradeable: false, disabledReason: "Waiting for verified feed.", opportunity: { score: 0, label: "WEAK" } }]);
    const card = screen.getByTestId("order-opp-EURUSD-M15").textContent ?? "";
    expect(card).not.toContain("BUY");
    expect(screen.getByTestId("order-opp-noread-EURUSD-M15").textContent).toBe("Waiting for verified feed.");
  });

  it("a live row from a scan older than 30 s shows no direction or score", () => {
    renderRows([{ ...base, generatedAt: new Date(now - 120_000).toISOString() }]);
    expect(screen.getByTestId("order-opp-EURUSD-M15").textContent).not.toContain("BUY");
    expect(screen.getByTestId("order-opp-noread-EURUSD-M15").textContent).toMatch(/more than 30 s old/);
  });

  it("a final read of NO_TRADE replaces the raw BUY", () => {
    renderRows([{ ...base, finalRead: { label: "NO_TRADE" } }]);
    const card = screen.getByTestId("order-opp-EURUSD-M15").textContent ?? "";
    expect(card).not.toContain("BUY");
    expect(card).toContain("No trade");
  });

  it("a fresh live tradeable row shows its action and score", () => {
    renderRows([base]);
    const card = screen.getByTestId("order-opp-EURUSD-M15").textContent ?? "";
    expect(card).toContain("BUY");
    expect(screen.getByTestId("order-opp-score-EURUSD-M15").textContent).toBe("82");
  });
});
