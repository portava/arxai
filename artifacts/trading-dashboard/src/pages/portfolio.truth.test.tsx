// Regression: the portfolio page read the legacy trades table and showed a
// green "Floating P&L $0.00" for open rows that were never marked to market,
// folded P/L-UNKNOWN closes into Realized P&L, labelled a net 24h loss
// "Daily Drawdown", and said "No exposure." with no hint that broker
// positions are not part of these figures.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let exposure: Record<string, unknown> = {};
vi.mock("@workspace/api-client-react", () => ({
  useGetPortfolioExposure: () => ({ data: exposure, isLoading: false }),
  useGetCorrelationWarnings: () => ({ data: [] }),
  getGetPortfolioExposureQueryKey: () => ["exp"],
  getGetCorrelationWarningsQueryKey: () => ["warn"],
}));
const { default: Portfolio } = await import("./portfolio");

const base = {
  totalOpen: 1, totalClosed: 1, floatingPnl: null, floatingPnlUnavailableReason: "1 of 1 open row not marked to market (no recorded P&L)",
  realizedPnl: 0, realizedPnlExcludedUnknown: 1, source: "LEGACY_TRADES_TABLE",
  sourceNote: "From the legacy trades table only. Broker positions are not included, so an empty view does not mean you have no open exposure.",
  exposureByMarket: {}, exposureByStrategy: {}, exposureByCurrency: [], dailyDrawdown: 0, weeklyDrawdown: 0,
};

afterEach(() => cleanup());

describe("portfolio page truth", () => {
  it("shows unmeasured floating P&L as unavailable, not $0.00", () => {
    exposure = { ...base };
    render(<Portfolio />);
    expect(screen.getByTestId("floating-pnl").textContent).toBe("Unavailable");
    expect(screen.getByText(/not marked to market/)).toBeTruthy();
    expect(screen.getByText(/1 closed trade excluded: P\/L unknown/)).toBeTruthy();
  });

  it("states the source scope, and does not say 'No exposure.'", () => {
    exposure = { ...base, sourceNote: undefined };
    render(<Portfolio />);
    expect(screen.getByTestId("portfolio-source-note").textContent).toMatch(/Broker positions are not included/);
    expect(screen.queryByText("No exposure.")).toBeNull();
    expect(screen.queryByText(/Daily Drawdown/)).toBeNull();
    expect(screen.getByText(/Net Loss, Last 24h/)).toBeTruthy();
  });

  it("prints a measured floating P&L", () => {
    exposure = { ...base, floatingPnl: 12.5, floatingPnlUnavailableReason: null, realizedPnlExcludedUnknown: 0 };
    render(<Portfolio />);
    expect(screen.getByTestId("floating-pnl").textContent).toBe("$12.50");
  });
});
