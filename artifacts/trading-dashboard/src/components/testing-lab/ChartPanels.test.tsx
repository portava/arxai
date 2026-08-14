import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { BacktestChartPanel } from "./BacktestChartPanel";
import { ForwardChartPanel } from "./ForwardChartPanel";

/**
 * Task #763 — honesty guards for the Testing Lab chart panels.
 *
 * Proves the display-only equity/drawdown panels render the honest provenance
 * label, surface the Focus-Lock blocked envelope, fall back to honest empty/error
 * states, and (forward) report realised R with the "no live orders" disclaimer —
 * never fabricating a curve. The heavy Recharts widgets are stubbed; these tests
 * cover the panel's branching + copy, not the chart library.
 */

vi.mock("@/components/analytics", () => ({
  EquityCurveChart: () => <div data-testid="equity-chart" />,
  DrawdownChart: () => <div data-testid="drawdown-chart" />,
}));

// react-query is driven per-test by re-assigning this implementation so the
// backtest panel (useQuery) can be steered into each branch.
let useQueryImpl: () => unknown = () => ({ data: undefined, isLoading: true, isError: false });
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => useQueryImpl(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BacktestChartPanel", () => {
  it("prompts to select a run when none is chosen", () => {
    useQueryImpl = () => ({ data: undefined, isLoading: false, isError: false });
    render(<BacktestChartPanel runId={null} />);
    expect(screen.getByText(/Select a run to see its equity curve/i)).toBeTruthy();
  });

  it("shows an honest error state when the series fails to load", () => {
    useQueryImpl = () => ({ data: undefined, isLoading: false, isError: true });
    render(<BacktestChartPanel runId={1} />);
    expect(screen.getByText(/Could not load the chart series/i)).toBeTruthy();
  });

  it("surfaces the Focus-Lock blocked envelope", () => {
    useQueryImpl = () => ({ data: { blocked: true }, isLoading: false, isError: false });
    render(<BacktestChartPanel runId={1} />);
    expect(screen.getByText(/outside ARX Focus and cannot be charted/i)).toBeTruthy();
  });

  it("renders the curve with the historical-simulation provenance label", () => {
    useQueryImpl = () => ({
      isLoading: false,
      isError: false,
      data: {
        kind: "BACKTEST",
        label: "Historical simulation",
        initialBalance: 10000,
        finalBalance: 10250,
        maxDrawdown: 400,
        equity: [{ tradeId: 0, openedAt: "x", equity: 10000, peak: 10000, drawdown: 0 }],
        markers: [],
        summary: {},
      },
    });
    render(<BacktestChartPanel runId={1} />);
    expect(screen.getByText("Historical simulation")).toBeTruthy();
    expect(screen.getByText(/Past performance does not guarantee future results/i)).toBeTruthy();
    expect(screen.getByTestId("equity-chart")).toBeTruthy();
    expect(screen.getByTestId("drawdown-chart")).toBeTruthy();
  });
});

describe("ForwardChartPanel", () => {
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            kind: "FORWARD",
            label: "Forward test (observed)",
            unit: "R",
            equity: [],
            markers: [],
            realizedR: 0,
            floatingR: null,
            maxDrawdownR: 0,
            openTrackingCount: 0,
            summary: { tracked: 0, wins: 0, losses: 0 },
          }),
      } as Response),
    ) as unknown as typeof fetch;
  });

  it("renders honest-empty forward state with the no-live-orders disclaimer", async () => {
    render(<ForwardChartPanel />);
    await waitFor(() => expect(screen.getByText("Forward test (observed)")).toBeTruthy());
    expect(screen.getByText(/No closed forward-test outcomes yet/i)).toBeTruthy();
    expect(screen.getByText(/No live orders are placed/i)).toBeTruthy();
  });

  it("shows an honest error state when the fetch fails", async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false } as Response)) as unknown as typeof fetch;
    render(<ForwardChartPanel />);
    await waitFor(() => expect(screen.getByText(/Could not load the forward chart series/i)).toBeTruthy());
  });
});
