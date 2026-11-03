// Analytics Command Center rendered the stored snapshot's money fields (Net
// P&L, Expectancy, Profit factor, Max DD, the Risk Exposure bars, strongest /
// weakest strategy) even when none of the closed trades could be sized in USD.
// analytics_snapshots columns are NOT NULL, so such a snapshot stores 0 (or,
// for a row written before contract-size P&L, a Δprice × lots × 100 figure),
// and the page showed it as a result. The server returns pnlCoverage beside
// the drawdown and strategy responses ("P&L not measured: ..."); the page
// never displayed it. It now shows the coverage note, reads "not measured" for
// every money figure when no trade could be sized, and says "could not be
// loaded" for a failed request instead of an empty or "computing" state.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AnalyticsCommandCenter from "./analytics-command";

const STORED_SNAPSHOT = {
  id: 9, createdAt: "2026-10-27T09:00:00.000Z",
  totalTrades: 3, netProfitLoss: 1234, winRate: 2 / 3, averageRr: 1.2,
  expectancy: 411.33, profitFactor: 2.5, maxDrawdown: 321,
  disciplineScoreAvg: 70, executionScoreAvg: 70, emotionalScoreAvg: 70, consistencyScoreAvg: 70,
  strongestStrategy: "XAUUSD", weakestStrategy: "US30",
  strongestMarketCondition: null, weakestMarketCondition: null,
};
const NONE_SIZED = {
  closedTrades: 3, sizedTrades: 0, unsizedTrades: 3, unsizedSymbols: ["US30", "XAUUSD"],
  note: "P&L not measured: none of your 3 closed trades could be sized in USD (US30, XAUUSD — no contract size or no USD conversion). Money figures here are not results.",
};
const PARTIAL = {
  closedTrades: 3, sizedTrades: 2, unsizedTrades: 1, unsizedSymbols: ["XAUUSD"],
  note: "P&L is in USD at each instrument's contract size (100,000 units per lot for a currency pair). 1 of 3 closed trades (XAUUSD) could not be sized and are left out of every money figure.",
};
// The same 2 sized trades the stored snapshot holds, computed now
// (GET /analytics/drawdown): +1555, then -321 → net 1234, max drawdown 321.
const CURVE_MATCHING_STORED = [
  { tradeId: 1, openedAt: "2026-10-26T09:00:00.000Z", equity: 1555, peak: 1555, drawdown: 0 },
  { tradeId: 2, openedAt: "2026-10-26T10:00:00.000Z", equity: 1234, peak: 1555, drawdown: 321 },
];
const SESSION_UNSIZED = {
  ASIA: { trades: 1, pnl: 0, wins: 1, sizedTrades: 0 },
  LONDON: { trades: 2, pnl: 0, wins: 1, sizedTrades: 0 },
  NEWYORK: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
};

type Route = { status: number; body: unknown };
function stub(routes: Record<string, Route>) {
  // The equity/drawdown charts measure their container when a curve has points.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const r = routes[key] ?? { status: 404, body: { error: "not stubbed" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
}
function routes(over: Partial<Record<string, Route>> = {}): Record<string, Route> {
  return {
    "GET /api/analytics/snapshot": { status: 200, body: { snapshot: STORED_SNAPSHOT } },
    "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: NONE_SIZED } },
    "GET /api/analytics/session": { status: 200, body: { session: SESSION_UNSIZED } },
    "GET /api/analytics/emotional": { status: 200, body: { trend: [], totalDebriefs: 0 } },
    "GET /api/analytics/drawdown": { status: 200, body: { equityCurve: [], maxDrawdown: 0, pnlCoverage: NONE_SIZED } },
    ...over,
  } as Record<string, Route>;
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AnalyticsCommandCenter /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Analytics Command Center — P&L coverage", () => {
  it("no closed trade could be sized: every money figure reads 'not measured', with the server's note", async () => {
    stub(routes());
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-pnl-coverage").textContent).toContain(NONE_SIZED.note));
    const page = document.body.textContent ?? "";
    for (const stored of ["$1234", "$411.33", "2.50", "$321"]) {
      expect(page, stored).not.toContain(stored);
    }
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("analytics-stat-expectancy").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("analytics-stat-profit-factor").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("analytics-stat-max-dd").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("analytics-highlight-best-symbol").textContent).toMatch(/not measured/);
    // Not "No closed trades yet." (there are 3) and no $0 session money.
    expect(page).not.toMatch(/No closed trades yet/);
    expect(page).not.toMatch(/\$0\b/);
    // Price-move figures stay: win rate and R are not money.
    expect(screen.getByTestId("analytics-stat-win-rate").textContent).toContain("66.7%");
  });

  it("some trades unsized: the figures show, with the note saying what was left out", async () => {
    stub(routes({
      "GET /api/analytics/drawdown": { status: 200, body: { equityCurve: CURVE_MATCHING_STORED, maxDrawdown: 321, pnlCoverage: PARTIAL } },
      "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: PARTIAL } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-pnl-coverage").textContent).toContain(PARTIAL.note));
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).toContain("$1234");
    // The tiles say which stored snapshot they come from, and that it was
    // checked against the trades computed now.
    const asof = screen.getByTestId("analytics-snapshot-asof").textContent ?? "";
    expect(asof).toContain("2026-10-27 09:00 UTC");
    expect(asof).toMatch(/match your closed trades as computed now/);
  });

  it("a stored snapshot from before contract-size P&L is not shown under the contract-size note as current", async () => {
    // One closed 1-lot, 100-pip EURUSD win. The stored row was computed as
    // Δprice × lots × 100 = $1; computed now at contract size it is $1,000.
    const OLD_BASIS = {
      ...STORED_SNAPSHOT, totalTrades: 1, netProfitLoss: 1, winRate: 1, expectancy: 1, profitFactor: 999,
      maxDrawdown: 0, strongestStrategy: "EURUSD", weakestStrategy: "EURUSD",
    };
    const ALL_SIZED = {
      closedTrades: 1, sizedTrades: 1, unsizedTrades: 0, unsizedSymbols: [],
      note: "P&L is in USD at each instrument's contract size (100,000 units per lot for a currency pair).",
    };
    stub(routes({
      "GET /api/analytics/snapshot": { status: 200, body: { snapshot: OLD_BASIS } },
      "GET /api/analytics/drawdown": { status: 200, body: {
        equityCurve: [{ tradeId: 1, openedAt: "2026-10-26T09:00:00.000Z", equity: 1000, peak: 1000, drawdown: 0 }],
        maxDrawdown: 0, pnlCoverage: ALL_SIZED,
      } },
      "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: ALL_SIZED } },
      "GET /api/analytics/session": { status: 200, body: { session: {} } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-snapshot-asof").textContent).toMatch(/no longer match/));
    const asof = screen.getByTestId("analytics-snapshot-asof").textContent ?? "";
    expect(asof).toContain("2026-10-27 09:00 UTC");
    expect(asof).toMatch(/Recompute snapshot/);
    // The old-basis money figures are not presented as contract-size results.
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).toMatch(/out of date/);
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).not.toMatch(/\$1\b/);
    expect(screen.getByTestId("analytics-stat-expectancy").textContent).toMatch(/out of date/);
    expect(screen.getByTestId("analytics-stat-profit-factor").textContent).toMatch(/out of date/);
    expect(screen.getByTestId("analytics-stat-max-dd").textContent).toMatch(/out of date/);
    expect(screen.getByTestId("analytics-highlight-best-symbol").textContent).toMatch(/out of date/);
    expect(screen.getByTestId("analytics-stat-net-pnl").innerHTML).not.toMatch(/emerald/);
    // The contract-size note is scoped to the figures computed now.
    expect(screen.getByTestId("analytics-pnl-coverage").textContent).toMatch(/^Computed now from your closed trades: P&L is in USD/);
  });

  it("trades closed after the snapshot: the tiles are not shown as matching the coverage note's count", async () => {
    // Stored snapshot: 3 trades. Computed now: 4 closed trades.
    stub(routes({
      "GET /api/analytics/drawdown": { status: 200, body: {
        equityCurve: [...CURVE_MATCHING_STORED, { tradeId: 3, openedAt: "2026-10-28T09:00:00.000Z", equity: 1300, peak: 1555, drawdown: 255 }],
        maxDrawdown: 321, pnlCoverage: { ...PARTIAL, closedTrades: 4, sizedTrades: 3 },
      } },
      "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: { ...PARTIAL, closedTrades: 4, sizedTrades: 3 } } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-snapshot-asof").textContent).toMatch(/no longer match.*4 closed trades/));
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).toMatch(/out of date/);
  });

  it("the live figures could not be loaded: the tiles say they could not be checked", async () => {
    stub(routes({
      "GET /api/analytics/drawdown": { status: 500, body: { error: "Failed to load drawdown" } },
      "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: PARTIAL } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-snapshot-asof").textContent).toMatch(/could not be checked/));
    expect(screen.getByTestId("analytics-snapshot-asof").textContent).toContain("2026-10-27 09:00 UTC");
  });

  it("some trades sized: a session whose trades could not be sized reads 'not measured', not a green $0", async () => {
    stub(routes({
      "GET /api/analytics/drawdown": { status: 200, body: { equityCurve: [], maxDrawdown: 0, pnlCoverage: PARTIAL } },
      "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: PARTIAL } },
      "GET /api/analytics/session": { status: 200, body: { session: {
        ASIA: { trades: 1, pnl: 0, wins: 1, sizedTrades: 0 },
        LONDON: { trades: 2, pnl: 150, wins: 1, sizedTrades: 2 },
        NEWYORK: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
      } } },
    }));
    renderPage();
    const asia = (await screen.findByText("ASIA")).parentElement as HTMLElement;
    expect(asia.textContent).toMatch(/not measured/);
    expect(asia.textContent).not.toMatch(/\$0/);
    expect((screen.getByText("LONDON").parentElement as HTMLElement).textContent).toContain("$150");
  });

  it("coverage requests failed: says it could not be loaded, not silence or an empty state", async () => {
    stub(routes({
      "GET /api/analytics/drawdown": { status: 500, body: { error: "Failed to load drawdown" } },
      "GET /api/analytics/strategy": { status: 500, body: { error: "Failed to load strategy analytics" } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-pnl-coverage").textContent).toMatch(/could not be loaded/));
    const page = document.body.textContent ?? "";
    expect(page).toMatch(/equity curve and drawdown could not be loaded/);
    expect(page).toMatch(/Strategy analytics could not be loaded/);
    expect(page).not.toMatch(/No closed trades yet/);
    expect(page).not.toMatch(/No strategy data/);
  });

  it("drawdown failed but the strategy response carries coverage: that coverage is used", async () => {
    stub(routes({ "GET /api/analytics/drawdown": { status: 500, body: { error: "Failed to load drawdown" } } }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-pnl-coverage").textContent).toContain(NONE_SIZED.note));
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).toMatch(/not measured/);
  });

  it("snapshot request failed: 'could not be loaded', never 'Computing your first analytics snapshot'", async () => {
    stub(routes({ "GET /api/analytics/snapshot": { status: 500, body: { error: "Failed to load snapshot" } } }));
    renderPage();
    await waitFor(() => expect(document.body.textContent).toMatch(/snapshot could not be loaded/));
    expect(document.body.textContent).not.toMatch(/Computing your first analytics snapshot/);
  });
});
