import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BacktestResultsDashboard } from "./BacktestResultsDashboard";
import { AIBacktestReviewCard } from "./AIBacktestReviewCard";
import { StrategyBacktestForm } from "./StrategyBacktestForm";
import { BacktestingTab } from "../testing-lab/BacktestingTab";
import { ResultsHistoryTab } from "../testing-lab/ResultsHistoryTab";

// Truth regressions for the Testing Lab backtesting surfaces: a run that never
// produced a completed simulated trade has no measured win rate, profit factor,
// P&L or expectancy; generated candles are not observed market depth; broker
// history is unattested; and the "review" is a deterministic template.

let run: Record<string, unknown>;
let mutate: ReturnType<typeof vi.fn>;
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    isError: false, isLoading: false,
    data: queryKey[0] === "backtest-run" ? run
      : queryKey[0] === "backtest-runs" ? { runs: [run] }
        : queryKey[0] === "backtest-trades" ? { trades: [] }
          : undefined,
  }),
  useQueries: ({ queries }: { queries: unknown[] }) => queries.map(() => ({ data: undefined })),
  useMutation: () => ({ mutate, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  LineChart: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  AreaChart: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  Line: () => null, Area: () => null, XAxis: () => null, YAxis: () => null,
  CartesianGrid: () => null, Tooltip: () => null, Legend: () => null, ReferenceLine: () => null,
}));

// Projection of the row the route inserts for an explicit range with too few
// broker bars: no metric columns are written, so the schema defaults (0) are
// what the read returns.
const insufficientBrokerRun = () => ({
  id: 7, strategyId: "trend", symbol: "EURUSD", timeframe: "M15", initialBalance: 10000,
  totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, profitFactor: 0,
  netProfitLoss: 0, maxDrawdown: 0, averageRr: 0, expectancy: 0,
  status: "INSUFFICIENT_DATA", isVerified: "UNVERIFIED", aiSummary: null,
  dataSource: "broker", createdAt: "2026-10-28T10:00:00.000Z",
});

beforeEach(() => { run = insufficientBrokerRun(); mutate = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("INSUFFICIENT_DATA runs are not shown as measured results", () => {
  it("results dashboard does not print schema-default zeros as a red measured result", () => {
    render(<BacktestResultsDashboard runId={7} />);
    expect(screen.getByText("INSUFFICIENT DATA")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
    const winRate = screen.getByText("Win rate").nextElementSibling as HTMLElement;
    expect(winRate.textContent).toBe("Not measured");
    expect(winRate.className).not.toContain("text-red-400");
    const pf = screen.getByText("Profit factor").nextElementSibling as HTMLElement;
    expect(pf.textContent).toBe("Not measured");
    expect(pf.className).not.toContain("text-red-400");
    for (const label of ["Gross P&L (price units)", "Expectancy (price units)", "Max DD (price units)", "Avg R:R", "Wins / losses"]) {
      expect((screen.getByText(label).nextElementSibling as HTMLElement).textContent).toBe("Not measured");
    }
    expect((screen.getByText("Trades").nextElementSibling as HTMLElement).textContent).toBe("None completed");
    expect(screen.getByText(/No completed simulated trades/)).toBeTruthy();
  });

  it("a completed run with trades still shows its measured numbers", () => {
    run = { ...run, status: "COMPLETED", totalTrades: 4, winningTrades: 1, losingTrades: 3, winRate: 0.25, profitFactor: 0.5, netProfitLoss: -0.002 };
    render(<BacktestResultsDashboard runId={7} />);
    const winRate = screen.getByText("Win rate").nextElementSibling as HTMLElement;
    expect(winRate.textContent).toBe("25%");
    expect(winRate.className).toContain("text-red-400");
  });

  it("recent runs row does not claim WR 0% / PF 0 / gross 0", () => {
    render(<BacktestingTab />);
    expect(screen.queryByText(/WR 0%/)).toBeNull();
    expect(screen.queryByText(/PF 0 /)).toBeNull();
    expect(screen.getByText(/No completed simulated trades · metrics not measured/)).toBeTruthy();
  });

  it("strategy results table does not show 0% / 0 for an unmeasured run", () => {
    render(<ResultsHistoryTab />);
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.getAllByText("Not measured").length).toBeGreaterThanOrEqual(3);
  });

  it("CSV export says not measured instead of 0%", async () => {
    let exported: Blob | undefined;
    vi.stubGlobal("URL", { createObjectURL: (blob: Blob) => { exported = blob; return "blob:test"; }, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ResultsHistoryTab />);
    fireEvent.click(screen.getByText("Export CSV"));
    const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(exported!); });
    vi.unstubAllGlobals();
    const row = text.split("\n")[1]!;
    expect(row).not.toContain("0%");
    expect(row).toContain("Not measured");
  });
});

describe("data depth pill describes what the candles were", () => {
  it("generated prices are not labelled as observed DATA next to INSUFFICIENT DATA", () => {
    run = { ...run, dataSource: "synthetic",
      dataReliability: { reliable: true, availableClosedCandles: 500, minimumRequiredCandles: 200, status: "sufficient" } };
    render(<BacktestResultsDashboard runId={7} />);
    expect(screen.queryByText("DATA · 500 bars")).toBeNull();
    const pill = screen.getByText("GENERATED · 500 bars");
    expect(pill.getAttribute("title")).toMatch(/generated, not observed market history/);
  });

  it("a broker run without a recorded depth says so instead of rendering nothing", () => {
    render(<BacktestResultsDashboard runId={7} />);
    const pill = screen.getByText("DEPTH NOT RECORDED");
    expect(pill.getAttribute("title")).toMatch(/not recorded/);
  });

  it("observed depth marked reliable still cannot read as reliable on an insufficient run", () => {
    run = { ...run, dataReliability: { reliable: true, availableClosedCandles: 400, minimumRequiredCandles: 200, status: "sufficient" } };
    render(<BacktestResultsDashboard runId={7} />);
    expect(screen.queryByText("DATA · 400 bars")).toBeNull();
    expect(screen.getByText("400 bars")).toBeTruthy();
  });

  it("observed depth on a completed run keeps the DATA pill", () => {
    run = { ...run, status: "COMPLETED", totalTrades: 3,
      dataReliability: { reliable: true, availableClosedCandles: 400, minimumRequiredCandles: 200, status: "sufficient" } };
    render(<BacktestResultsDashboard runId={7} />);
    expect(screen.getByText("DATA · 400 bars")).toBeTruthy();
  });
});

describe("form and summary copy", () => {
  it("form footer does not upgrade unattested broker history to 'real'", () => {
    render(<StrategyBacktestForm />);
    expect(screen.queryByText(/real broker history/)).toBeNull();
    expect(screen.getByText(/broker history whose source and account identity are not verified/)).toBeTruthy();
  });

});
