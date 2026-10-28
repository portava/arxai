// Regression: the portfolio page read the legacy trades table and showed a
// green "Floating P&L $0.00" for open rows that were never marked to market,
// folded P/L-UNKNOWN closes into Realized P&L, labelled a net 24h loss
// "Daily Drawdown", and said "No exposure." with no hint that broker
// positions are not part of these figures.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let exposure: Record<string, unknown> = {};
// Query-state overrides for the read-failure tests (data, isError, times).
let exposureQ: Record<string, unknown> | null = null;
let warnQ: Record<string, unknown> = { data: [] };
vi.mock("@workspace/api-client-react", () => ({
  useGetPortfolioExposure: () => exposureQ ?? ({ data: exposure, isLoading: false }),
  useGetCorrelationWarnings: () => warnQ,
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

afterEach(() => { cleanup(); exposureQ = null; warnQ = { data: [] }; });

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

  // Regression: the page was titled "Portfolio Exposure — Risk distribution
  // across markets, strategies, and currencies" and said "No currency
  // exposure." while every figure came from a frozen table of simulated rows;
  // the trader's paper book and DEMO EA positions never appear here.
  it("says the rows are simulated and the paper book and DEMO EA positions are not included, even with an older server note", () => {
    exposure = { ...base, totalOpen: 0, totalClosed: 0, floatingPnl: 0, floatingPnlUnavailableReason: null, realizedPnlExcludedUnknown: 0 };
    render(<Portfolio />);
    const scope = screen.getByTestId("portfolio-scope").textContent ?? "";
    expect(scope).toMatch(/simulat/i);
    expect(scope).toMatch(/paper book/i);
    expect(scope).toMatch(/DEMO EA positions/);
    expect(screen.queryByText("No currency exposure.")).toBeNull();
    expect(screen.queryByText(/Risk distribution across markets/)).toBeNull();
    expect(screen.getByText(/Simulated realized P&L/)).toBeTruthy();
    // A zero 24h net loss is not painted as a loss.
    expect(screen.getByTestId("daily-net-loss").className).not.toMatch(/text-destructive/);
  });
});

// Regression: "if (isLoading || !exp) return <Skeleton/>" left the page
// loading forever when the first read failed; a failed 10 s refetch kept the
// old figures with no marker; a failed correlation read made the warnings
// card vanish, which looked the same as having no correlated positions; and
// negative P&L printed as "$-12.00".
describe("portfolio page read failures", () => {
  it("a failed first read says the exposure could not be loaded, not an endless skeleton", () => {
    const refetch = vi.fn();
    exposureQ = { data: undefined, isLoading: false, isError: true, refetch };
    const { container } = render(<Portfolio />);
    expect(screen.getByTestId("portfolio-load-error").textContent).toMatch(/could not be loaded/);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    screen.getByTestId("button-retry-exposure").click();
    expect(refetch).toHaveBeenCalled();
  });

  it("a failed refetch after a good read marks the kept figures as not current, with the load time", () => {
    const loadedAt = new Date("2026-10-28T11:00:00Z").getTime();
    exposureQ = { data: { ...base }, isLoading: false, isError: true, dataUpdatedAt: loadedAt, errorUpdatedAt: loadedAt + 10_000 };
    render(<Portfolio />);
    const stale = screen.getByTestId("portfolio-stale").textContent ?? "";
    expect(stale).toMatch(/not current/);
    expect(stale).toContain(new Date(loadedAt).toLocaleTimeString());
  });

  it("a successful read shows when it was loaded and no stale marker", () => {
    exposureQ = { data: { ...base }, isLoading: false, isError: false, dataUpdatedAt: Date.now() };
    render(<Portfolio />);
    expect(screen.queryByTestId("portfolio-stale")).toBeNull();
    expect(screen.getByTestId("portfolio-loaded-at").textContent).toMatch(/Loaded at/);
  });

  it("a failed correlation read says the check could not be loaded instead of vanishing", () => {
    exposure = { ...base };
    warnQ = { data: undefined, isError: true };
    render(<Portfolio />);
    expect(screen.getByTestId("correlation-load-error").textContent).toMatch(/could not be loaded/);
    expect(screen.queryByTestId("correlation-none")).toBeNull();
  });

  it("an empty correlation result says so plainly", () => {
    exposure = { ...base };
    render(<Portfolio />);
    expect(screen.getByTestId("correlation-none").textContent).toMatch(/No correlated open rows in this source/);
  });

  it("prints a negative P&L as -$12.00, not $-12.00", () => {
    exposure = { ...base, floatingPnl: -12, floatingPnlUnavailableReason: null, realizedPnl: -12, realizedPnlExcludedUnknown: 0 };
    render(<Portfolio />);
    expect(screen.getByTestId("floating-pnl").textContent).toBe("-$12.00");
    expect(screen.getByTestId("realized-pnl").textContent).toBe("-$12.00");
    expect(document.body.textContent).not.toMatch(/\$-/);
  });
});
