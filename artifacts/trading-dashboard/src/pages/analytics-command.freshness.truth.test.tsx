// Analytics Command Center: the tiles say when they were computed and from
// what, and agree with the live tables below them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AnalyticsCommandCenter from "./analytics-command";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const FIGURES = {
  totalTrades: 5, netProfitLoss: 5000, winRate: 1, averageRr: 2, expectancy: 1000,
  profitFactor: 999, maxDrawdown: 0,
  disciplineScoreAvg: 80, executionScoreAvg: 70, emotionalScoreAvg: 60, consistencyScoreAvg: 50,
  strongestStrategy: "EURUSD", weakestStrategy: null,
  strongestMarketCondition: null, weakestMarketCondition: null,
};
const SAVED = { ...FIGURES, id: 3, totalTrades: 3, netProfitLoss: 3000, createdAt: "2026-10-20T10:00:00.000Z" };

function serve(snapshotBody: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/analytics/snapshot") && init?.method !== "POST") return new Response(JSON.stringify(snapshotBody), { status: 200 });
    if (u.includes("/api/analytics/strategy")) return new Response(JSON.stringify({ strategies: [] }), { status: 200 });
    if (u.includes("/api/analytics/session")) return new Response(JSON.stringify({ session: {} }), { status: 200 });
    if (u.includes("/api/analytics/emotional")) return new Response(JSON.stringify({ trend: [], totalDebriefs: 0 }), { status: 200 });
    if (u.includes("/api/analytics/drawdown")) return new Response(JSON.stringify({ equityCurve: [], maxDrawdown: 0 }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
}
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AnalyticsCommandCenter /></QueryClientProvider>);
}

describe("Analytics Command Center freshness", () => {
  it("shows the figures computed now, with their time, not the older saved snapshot", async () => {
    serve({ snapshot: SAVED, current: { ...FIGURES, asOf: "2026-10-28T12:00:00.000Z" }, currentError: null });
    renderPage();
    const asOf = await screen.findByTestId("analytics-asof");
    expect(asOf.textContent).toContain("Computed from all your paper orders at");
    expect(asOf.textContent).toContain(new Date("2026-10-28T12:00:00.000Z").toLocaleString());
    expect(asOf.textContent).toContain(`Last saved snapshot: ${new Date(SAVED.createdAt).toLocaleString()}`);
    expect(screen.getByTestId("analytics-stat-trades").textContent).toBe("Trades5");
  });

  it("a saved snapshot alone says when it was computed and that later trades are not in it", async () => {
    serve({ snapshot: SAVED });
    renderPage();
    const asOf = await screen.findByTestId("analytics-asof");
    expect(asOf.textContent).toContain(`Saved snapshot computed ${new Date(SAVED.createdAt).toLocaleString()}`);
    expect(asOf.textContent).toContain("trades closed after it are not included");
    expect(screen.getByTestId("analytics-stat-trades").textContent).toBe("Trades3");
  });
});

describe("Analytics Command Center highlights", () => {
  it("names symbols and edge slices for what they are, with their basis", async () => {
    serve({
      snapshot: SAVED,
      current: {
        ...FIGURES, asOf: "2026-10-28T12:00:00.000Z",
        strongestSymbol: "EURUSD", weakestSymbol: null,
        strongestEdgeSlice: { edgeName: "symbol=EURUSD", label: "EURUSD (by symbol)", status: "DEVELOPING_EDGE", statusWords: "developing edge", confidenceScore: 45, sampleSize: 12, reportedAt: null },
        weakestEdgeSlice: null,
        highlightBasis: {
          symbols: "Best and worst symbol by the net P&L of their closed paper trades sized in USD. The best must be net profitable and the worst net losing.",
          edgeSlices: "From Edge Discovery's current reports, ranked by edge status and then by the report's confidence score — not by your results in a market condition. A slice with too little data is not ranked.",
        },
      },
    });
    renderPage();
    const best = await screen.findByTestId("analytics-highlight-best-symbol");
    expect(best.textContent).toContain("Best symbol (net P&L)");
    expect(best.textContent).toContain("EURUSD");
    expect(screen.getByTestId("analytics-highlight-worst-symbol").textContent).toContain("No symbol is net losing");
    const edge = screen.getByTestId("analytics-highlight-strongest-edge").textContent ?? "";
    expect(edge).toContain("EURUSD (by symbol) — developing edge, confidence 45/100 (12 trades)");
    expect(edge).toContain("not by your results in a market condition");
    expect(document.body.textContent).not.toMatch(/Strongest strategy|Weakest strategy|Strongest market condition|Weakest market condition/);
  });
});

describe("Analytics Command Center saved symbol highlights", () => {
  // The stored "strategy" columns are the plain top and bottom symbol by net
  // P&L (the trade decision reads them), so a saved row can name a losing
  // symbol as the top one, and one traded symbol as both.
  it("a saved snapshot's best / worst symbol says it is a ranking, not a profit or loss", async () => {
    serve({ snapshot: { ...SAVED, strongestStrategy: "EURUSD", weakestStrategy: "EURUSD" } });
    renderPage();
    const best = await screen.findByTestId("analytics-highlight-best-symbol");
    expect(best.textContent).toContain("EURUSD");
    expect(best.textContent).toContain("highest net P&L when the snapshot was saved");
    expect(best.textContent).toContain("does not record whether it was net profitable");
    const worst = screen.getByTestId("analytics-highlight-worst-symbol").textContent ?? "";
    expect(worst).toContain("lowest net P&L when the snapshot was saved");
    expect(worst).toContain("does not record whether it was net losing");
    expect(worst).toContain("with one traded symbol it is also the best");
  });
});

describe("Analytics Command Center unmeasured figures", () => {
  it("a new user's tiles read — with the reason, not 0 / 0% / $0 in red", async () => {
    serve({
      snapshot: null,
      current: {
        ...FIGURES, asOf: "2026-10-28T12:00:00.000Z", totalTrades: 0,
        netProfitLoss: null, winRate: null, averageRr: null, expectancy: null, profitFactor: null, maxDrawdown: null,
        disciplineScoreAvg: null, executionScoreAvg: null, emotionalScoreAvg: null, consistencyScoreAvg: null,
        unmeasured: {
          winRate: "No closed paper trades yet.", netProfitLoss: "No closed paper trades yet.",
          expectancy: "No closed paper trades yet.", profitFactor: "No closed paper trades yet.",
          maxDrawdown: "No closed paper trades yet.", averageRr: "No closed paper trades yet.",
          disciplineScoreAvg: "No Trader Skill profile has been computed yet.",
          executionScoreAvg: "No Trader Skill profile has been computed yet.",
          emotionalScoreAvg: "No post-trade debriefs yet.",
          consistencyScoreAvg: "No Trader Skill profile has been computed yet.",
        },
      },
    });
    renderPage();
    const winRate = await screen.findByTestId("analytics-stat-win-rate");
    expect(winRate.textContent).toBe("Win rate—");
    expect(screen.getByTestId("analytics-stat-net-pnl").textContent).toBe("Net P&L (USD)—");
    expect(screen.getByTestId("analytics-stat-avg-rr").textContent).toBe("Avg RR—");
    expect(screen.getByTestId("analytics-stat-expectancy").textContent).toBe("Expectancy—");
    expect(screen.getByTestId("analytics-stat-profit-factor").textContent).toBe("Profit factor—");
    const dd = screen.getByTestId("analytics-stat-max-dd");
    expect(dd.textContent).toBe("Max DD—");
    expect(dd.querySelector(".text-red-300")).toBeNull();
    expect(screen.getByTestId("analytics-unmeasured").textContent).toContain("Win rate (No closed paper trades yet)");
    expect(screen.getByTestId("consistency-Discipline").textContent).toContain("—");
  });

  it("an older server's saved snapshot with no trades is downgraded, not shown as 0%", async () => {
    serve({ snapshot: { ...SAVED, totalTrades: 0, netProfitLoss: 0, winRate: 0, averageRr: 0, expectancy: 0, profitFactor: 0, maxDrawdown: 0 } });
    renderPage();
    const winRate = await screen.findByTestId("analytics-stat-win-rate");
    expect(winRate.textContent).toBe("Win rate—");
    expect(screen.getByTestId("analytics-stat-max-dd").textContent).toBe("Max DD—");
    expect(screen.getByTestId("analytics-unmeasured").textContent).toContain("No closed paper trades when this snapshot was saved");
  });

  it("a saved profit factor of 999 (no losing trade) is not shown as ∞ or 999.00", async () => {
    serve({ snapshot: SAVED });
    renderPage();
    const pf = await screen.findByTestId("analytics-stat-profit-factor");
    expect(pf.textContent).toBe("Profit factor—");
    expect(screen.getByTestId("analytics-unmeasured").textContent).toContain("No losing trade");
  });
});

describe("Analytics Command Center P&L basis", () => {
  it("labels Net P&L as USD and says it differs from the booked demo P&L in Ruby Memory", async () => {
    const note = "P&L is in USD at each instrument's contract size (100,000 units per lot for a currency pair), recomputed from each trade's entry and exit price. Ruby Memory and your demo account show the P&L the paper venue booked on each close: older closes may have been booked as price move × lots × 100, and a close it could not size is booked as a placeholder (0 in Ruby Memory, the paper risk model in your demo balance), so their Net P&L can differ from this one.";
    serve({
      snapshot: SAVED,
      current: { ...FIGURES, asOf: "2026-10-28T12:00:00.000Z",
        pnlCoverage: { closedTrades: 5, sizedTrades: 5, unsizedTrades: 0, unsizedSymbols: [], note } },
    });
    renderPage();
    const pnl = await screen.findByTestId("analytics-stat-net-pnl");
    expect(pnl.textContent).toBe("Net P&L (USD)$5000");
    // One coverage line carries the basis note (merged with the coverage line of analytics-command.pnlCoverage).
    expect(screen.getByTestId("analytics-pnl-coverage").textContent).toContain("Ruby Memory and your demo account show the P&L the paper venue booked");
  });
});
