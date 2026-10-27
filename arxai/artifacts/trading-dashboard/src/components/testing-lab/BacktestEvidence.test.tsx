import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BacktestResultsDashboard } from "../backtesting/BacktestResultsDashboard";
import { AIBacktestReviewCard } from "../backtesting/AIBacktestReviewCard";
import { BacktestTradeList } from "../backtesting/BacktestTradeList";
import { ResultsHistoryTab } from "./ResultsHistoryTab";
import { ComparisonTab } from "./ComparisonTab";
import { ComparisonOverlayChart } from "./ComparisonOverlayChart";
import type { BacktestRunRow } from "./types";

let run: any;
let runs: BacktestRunRow[];
let historyError: boolean;
let forwardResponse: unknown;
let tradesResponse: unknown;
const forward = { shadowTradesTracked: 100, totalShadowDecisions: 100, winRate: 90, avgR: 2, maxDrawdownR: 0 };
const chart = { initialBalance: 10000, equity: [{ tradeId: 0, equity: 10100, grossPriceUnits: 100, peakGrossPriceUnits: 100 }], strategyId: "trend", symbol: "EURUSD" };
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({ isError: historyError, data: queryKey[0] === "backtest-run" ? run
    : queryKey[0] === "backtest-runs" ? { runs }
      : queryKey[0] === "backtest-trades" ? tradesResponse
      : queryKey[0] === "forward-chart-series" ? { equity: [{ tradeId: 0, equity: 2 }] } : forwardResponse }),
  useQueries: ({ queries }: { queries: unknown[] }) => queries.map(() => ({ data: chart })),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div data-testid="line-chart">{children}</div>,
  Line: ({ name }: any) => <span>{name}</span>,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
}));
beforeEach(() => {
  run = { id: 1, strategyId: "trend", symbol: "EURUSD", timeframe: "M15", totalTrades: 100,
    winningTrades: 90, losingTrades: 10, winRate: .9, profitFactor: 10, netProfitLoss: 100,
    maxDrawdown: 10, averageRr: 2, expectancy: 1, status: "COMPLETED", isVerified: "VERIFIED",
    dataSource: "broker", aiSummary: "Verified and ready for live", createdAt: "2026-01-01",
    evidence: { verification: "verified", comparisonEligible: true } };
  runs = [run];
  historyError = false;
  forwardResponse = forward;
  tradesResponse = { trades: [] };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("legacy backtest evidence containment", () => {
  it("does not render a stored VERIFIED badge or treat broker label as account proof", () => {
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.getByText("DIAGNOSTIC ONLY")).toBeTruthy();
    expect(screen.queryByText("VERIFIED")).toBeNull();
    expect(screen.getByText("Broker history · identity unverified")).toBeTruthy();
    expect(screen.getByText("Gross P&L (price units)")).toBeTruthy();
    expect(screen.getByText(/fees, spreads, slippage and liquidity are not modelled/)).toBeTruthy();
  });
  it("missing source is unknown rather than synthetic", () => {
    delete run.dataSource;
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.getByText("Source unknown")).toBeTruthy();
    expect(screen.queryByText("Generated prices")).toBeNull();
  });
  it("generated prices stay distinguishable from observed history", () => {
    run.dataSource = "synthetic";
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.getByText("Generated prices")).toBeTruthy();
    expect(screen.getByText(/Prices were generated/)).toBeTruthy();
  });
  it("small FX losses and drawdown are not rounded to zero", () => {
    run.netProfitLoss = -.001; run.maxDrawdown = .001; run.expectancy = -.00001;
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.getByText("-0.001")).toBeTruthy();
    expect(screen.getByText("0.001")).toBeTruthy();
  });
  it("missing and nonfinite metrics render unavailable without crashing", () => {
    run.netProfitLoss = null; run.maxDrawdown = NaN; run.expectancy = Infinity;
    run.averageRr = null; run.winRate = null; run.profitFactor = null;
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });
  it("finite profit factor1000 is not displayed as infinity", () => {
    run.profitFactor = 1000;
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.queryByText("∞")).toBeNull();
    expect(screen.getAllByText(/1,?000/).length).toBeGreaterThan(0);
  });
  it("ambiguous legacy999 is not displayed as infinite performance", () => {
    run.profitFactor = 999;
    render(<BacktestResultsDashboard runId={1} />);
    expect(screen.queryByText("∞")).toBeNull();
    expect(screen.getByText("Unavailable (legacy 999 marker)")).toBeTruthy();
  });
  it("AI card does not republish legacy verification prose", () => {
    render(<AIBacktestReviewCard runId={1} />);
    expect(screen.queryByText(/Verified and ready for live/)).toBeNull();
    expect(screen.getByText(/Diagnostic only — trend/)).toBeTruthy();
  });
  it("failed detail, trade and summary reads show unavailable rather than loading or zero trades", () => {
    historyError = true;
    render(<><BacktestResultsDashboard runId={1} /><BacktestTradeList runId={1} /><AIBacktestReviewCard runId={1} /></>);
    expect(screen.getByText("Results unavailable for this run.")).toBeTruthy();
    expect(screen.getByText("Trades unavailable for this run.")).toBeTruthy();
    expect(screen.getByText("Diagnostic summary unavailable.")).toBeTruthy();
    expect(screen.queryByText("No trades produced by this run.")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
  it("missing trade P&L is unavailable and never positive", () => {
    tradesResponse = { trades: [{ id: 1, direction: "BUY", entryPrice: 1.1, exitPrice: 1.09, profitLoss: null, rewardToRisk: 1, result: "LOSS" }] };
    render(<BacktestTradeList runId={1} />);
    expect(screen.getByText("Unavailable").className).toContain("text-slate-400");
    expect(screen.queryByText("+Unavailable")).toBeNull();
  });
  it("history cannot turn a large profitable legacy run into readiness", () => {
    render(<ResultsHistoryTab />);
    expect(screen.getByText("Diagnostic only")).toBeTruthy();
    expect(screen.queryByText("Ready for review")).toBeNull();
  });
  it("CSV does not export the legacy verification claim", async () => {
    run.profitFactor = 1000;
    let exported: Blob | undefined;
    vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { exported = blob; return "blob:test"; }, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ResultsHistoryTab />); fireEvent.click(screen.getByText("Export CSV"));
    const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!); });
    expect(text).toContain("grossPriceUnits"); expect(text).toContain(",UNVERIFIED,"); expect(text).not.toContain(",VERIFIED,");
    expect(text).toContain(',"1,000",');
    vi.unstubAllGlobals();
  });
  it("failed reads do not claim zero history or export stale runs", () => {
    historyError = true;
    render(<ResultsHistoryTab />);
    expect(screen.getByText("Backtest history unavailable.")).toBeTruthy();
    expect(screen.getByText("Forward-test history unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No .* results yet/)).toBeNull();
    expect((screen.getByText("Export CSV") as HTMLButtonElement).disabled).toBe(true);
  });
  it("missing forward results are unavailable while a confirmed empty history stays empty", () => {
    forwardResponse = undefined;
    const view = render(<ResultsHistoryTab />);
    expect(screen.getByText("Forward-test history unavailable.")).toBeTruthy();
    forwardResponse = { ...forward, shadowTradesTracked: 0 };
    view.rerender(<ResultsHistoryTab />);
    expect(screen.getByText("No forward-test results yet.")).toBeTruthy();
    expect(screen.queryByText("Forward-test history unavailable.")).toBeNull();
  });
  it("matching win rates cannot claim out-of-sample edge or alignment", () => {
    render(<ComparisonTab />);
    expect(screen.getByText("Comparison unavailable")).toBeTruthy();
    expect(screen.queryByText(/Aligned \(/)).toBeNull();
    expect(screen.queryByText(/edge is holding up/)).toBeNull();
    expect(screen.getByText(/forward summary covers all strategies, symbols and timeframes/)).toBeTruthy();
  });
  it("strategy changes cannot retain an unrelated selected run", () => {
    runs = [run, { ...run, id: 2, strategyId: "other" }];
    const view = render(<ComparisonTab strategyId="trend" />);
    fireEvent.change(screen.getByLabelText("Curve A"), { target: { value: "1" } });
    expect(screen.getByText("trend · EURUSD (price units)")).toBeTruthy();
    view.rerender(<ComparisonTab strategyId="other" />);
    expect(screen.queryByText("trend · EURUSD (price units)")).toBeNull();
    view.rerender(<ComparisonTab strategyId="trend" />);
    expect(screen.queryByText("trend · EURUSD (price units)")).toBeNull();
    expect((screen.getByLabelText("Curve A") as HTMLSelectElement).value).toBe("");
  });
  it("R and price units are drawn on separate charts", () => {
    render(<ComparisonOverlayChart series={[
      { key: "a", label: "Backtest", unit: "price units", color: "red", points: [{ tradeId: 1, value: 100 }] },
      { key: "b", label: "Forward", unit: "R", color: "blue", points: [{ tradeId: 1, value: 1 }] },
    ]} />);
    expect(screen.getAllByTestId("line-chart")).toHaveLength(2);
    expect(screen.getByText("Growth from start (price units)")).toBeTruthy();
    expect(screen.getByText("Growth from start (R)")).toBeTruthy();
  });
});
