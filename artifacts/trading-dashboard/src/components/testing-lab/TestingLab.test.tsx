import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import TestingLab from "@/pages/testing-lab";

/**
 * Testing Lab page guard (Backtesting + Forward Testing unification).
 *
 * Proves the unified page renders all four tabs, defaults to Backtesting,
 * switches between tabs, and that the shared strategy selector (lifted to the
 * page, outside the tabs) persists its value across tab switches. The data
 * hooks are mocked to the honest-empty shape so the empty-state branches of the
 * Comparison and Results/History tabs are exercised without a backend.
 */

// useQuery → honest-empty (no runs / no forward results) for every tab.
// useQueries (Comparison overlay) → no selected runs → empty results array.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useQueries: () => [],
}));

// The backtest component suite is stubbed: this test covers the Testing Lab
// shell (tabs + shared strategy), not the already-tested backtest widgets.
vi.mock("@/components/backtesting", () => ({
  StrategyBacktestForm: (p: { strategyId?: string }) => (
    <div data-testid="strategy-form" data-strategy={p.strategyId ?? ""} />
  ),
  BacktestResultsDashboard: () => <div data-testid="bt-dashboard" />,
  BacktestTradeList: () => <div data-testid="bt-trades" />,
  AIBacktestReviewCard: () => <div data-testid="bt-ai" />,
}));

beforeEach(() => {
  // ForwardTestingTab fetches status/results on mount; keep it honest + quiet.
  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ shadowTradesTracked: 0, totalShadowDecisions: 0, winRate: 0, avgR: 0 }),
    } as Response),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Radix Tabs use "automatic" activation (focus-driven), so a bare click does
// not switch tabs in jsdom. Focus + click mirrors a real pointer selection.
function selectTab(name: string) {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
}

describe("Testing Lab page", () => {
  it("renders the header and subtitle", () => {
    render(<TestingLab />);
    expect(screen.getByRole("heading", { name: "Testing Lab" })).toBeTruthy();
    expect(
      screen.getByText(/Test strategies against historical data and live market conditions/i),
    ).toBeTruthy();
  });

  it("exposes all four tabs", () => {
    render(<TestingLab />);
    expect(screen.getByRole("tab", { name: "Backtesting" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Forward Testing" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Comparison" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Strategy Results" })).toBeTruthy();
  });

  it("defaults to the Backtesting tab", () => {
    render(<TestingLab />);
    expect(screen.getByTestId("strategy-form")).toBeTruthy();
    expect(screen.getByText("Recent runs")).toBeTruthy();
    // Forward tab content is not mounted while Backtesting is active.
    expect(screen.queryByText("Start a forward test")).toBeNull();
  });

  it("switches to the Forward Testing tab", () => {
    render(<TestingLab />);
    selectTab("Forward Testing");
    expect(screen.getByText("Start a forward test")).toBeTruthy();
  });

  it("shows an honest-empty Comparison tab when there is no data", () => {
    render(<TestingLab />);
    selectTab("Comparison");
    expect(screen.getByText(/No comparison data yet/i)).toBeTruthy();
  });

  it("shows an honest-empty Results/History tab when there are no runs", () => {
    render(<TestingLab />);
    selectTab("Strategy Results");
    expect(screen.getByText("No backtest runs yet.")).toBeTruthy();
  });

  it("keeps the shared strategy selection when switching tabs", () => {
    render(<TestingLab />);
    const select = screen.getByTestId("shared-strategy-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "meanReversion" } });
    expect(select.value).toBe("meanReversion");

    selectTab("Forward Testing");
    selectTab("Backtesting");

    const after = screen.getByTestId("shared-strategy-select") as HTMLSelectElement;
    expect(after.value).toBe("meanReversion");
  });

  it("feeds the shared strategy into the backtest form", () => {
    render(<TestingLab />);
    const select = screen.getByTestId("shared-strategy-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "liquiditySweep" } });
    expect(screen.getByTestId("strategy-form").getAttribute("data-strategy")).toBe("liquiditySweep");
  });
});
