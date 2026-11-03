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
