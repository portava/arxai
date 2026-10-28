// Win/Loss Report: the footer names the table the numbers came from, and an
// environment the server did not read shows "—", never a measured 0.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import PerformanceScorecard from "./performance-scorecard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SCORECARD = {
  environments: {
    JOURNAL: { trades: 3, wins: 2, losses: 1, winRate: 67, pnl: 20,
      note: "All your journal entries. Journal entries record no environment, so paper, demo and live are not separated here." },
    DEMO_SIMULATOR: { trades: null, note: "Not read by this report — demo simulator results are kept in a separate table." },
    REAL_BROKER: { trades: null, status: "Not read by this report — real broker execution is deferred and has never executed." },
  },
  headline: { winRate: 67, totalPnl: 20, totalTrades: 3 },
  bestSymbol: "EURUSD", worstSymbol: "GBPUSD",
  strategyRanking: [], mistakeDistribution: {}, gradeDistribution: {},
  dataSource: "TRADE_JOURNAL", dataSourceLabel: "your trade journal entries",
  generatedAt: "2026-10-28T10:00:00.000Z",
};

describe("Win/Loss Report source truth", () => {
  it("names the journal as the source and shows unread environments as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/performance/scorecard")
        ? new Response(JSON.stringify(SCORECARD), { status: 200 })
        : new Response("null", { status: 404 })));
    render(<PerformanceScorecard />);
    const footer = await screen.findByTestId("scorecard-source");
    expect(footer.textContent).toContain("Data source: your trade journal entries");
    expect(footer.textContent).not.toMatch(/SIMULATOR_AND_TESTER_INTENTS/);
    expect(screen.getByTestId("env-trades-JOURNAL").textContent).toBe("3");
    expect(screen.getByTestId("env-trades-DEMO_SIMULATOR").textContent).toBe("—");
    expect(screen.getByTestId("env-trades-REAL_BROKER").textContent).toBe("—");
    expect(document.body.textContent).not.toMatch(/never mixed across environments/);
  });
});
