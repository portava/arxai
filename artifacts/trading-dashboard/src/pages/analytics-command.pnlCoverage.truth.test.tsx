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
const SESSION_UNSIZED = {
  ASIA: { trades: 1, pnl: 0, wins: 1, sizedTrades: 0 },
  LONDON: { trades: 2, pnl: 0, wins: 1, sizedTrades: 0 },
  NEWYORK: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
};

type Route = { status: number; body: unknown };
function stub(routes: Record<string, Route>) {
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
    expect(screen.getByTestId("stat-net-p-l").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("stat-expectancy").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("stat-profit-factor").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("stat-max-dd").textContent).toMatch(/not measured/);
    expect(screen.getByTestId("highlight-strongest-strategy").textContent).toMatch(/not measured/);
    // Not "No closed trades yet." (there are 3) and no $0 session money.
    expect(page).not.toMatch(/No closed trades yet/);
    expect(page).not.toMatch(/\$0\b/);
    // Price-move figures stay: win rate and R are not money.
    expect(screen.getByTestId("stat-win-rate").textContent).toContain("66.7%");
  });

  it("some trades unsized: the figures show, with the note saying what was left out", async () => {
    stub(routes({
      "GET /api/analytics/drawdown": { status: 200, body: { equityCurve: [], maxDrawdown: 0, pnlCoverage: PARTIAL } },
      "GET /api/analytics/strategy": { status: 200, body: { strategies: [], pnlCoverage: PARTIAL } },
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("analytics-pnl-coverage").textContent).toContain(PARTIAL.note));
    expect(screen.getByTestId("stat-net-p-l").textContent).toContain("$1234");
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
    expect(screen.getByTestId("stat-net-p-l").textContent).toMatch(/not measured/);
  });

  it("snapshot request failed: 'could not be loaded', never 'Computing your first analytics snapshot'", async () => {
    stub(routes({ "GET /api/analytics/snapshot": { status: 500, body: { error: "Failed to load snapshot" } } }));
    renderPage();
    await waitFor(() => expect(document.body.textContent).toMatch(/snapshot could not be loaded/));
    expect(document.body.textContent).not.toMatch(/Computing your first analytics snapshot/);
  });
});
