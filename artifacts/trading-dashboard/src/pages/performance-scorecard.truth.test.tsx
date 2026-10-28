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

// The server's win rate is over decided trades (a recorded win or loss) and
// is null when there are none; the page shows that as unknown, never "null%"
// or a measured 0%.
describe("Win/Loss Report win rate", () => {
  it("a null win rate (no decided trade) renders as —, not null% or 0%", async () => {
    const body = {
      ...SCORECARD,
      environments: { ...SCORECARD.environments, JOURNAL: { ...SCORECARD.environments.JOURNAL, wins: 0, losses: 0, winRate: null, pnl: 0 } },
      headline: { winRate: null, tradesDecided: 0, totalPnl: 0, totalTrades: 3, tradesWithRecordedPnl: 2 },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/performance/scorecard")
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("null", { status: 404 })));
    render(<PerformanceScorecard />);
    const read = await screen.findByTestId("performance-read");
    expect(read.textContent).not.toMatch(/Win rate is/);
    expect(document.body.textContent).not.toMatch(/null%/);
    const card = screen.getAllByText("Win Rate")[0]!.parentElement!.parentElement!;
    expect(card.textContent).toBe("Win Rate—");
  });

  it("names how many decided trades the win rate covers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/performance/scorecard")
        ? new Response(JSON.stringify({ ...SCORECARD, headline: { ...SCORECARD.headline, tradesDecided: 3, tradesWithRecordedPnl: 3 } }), { status: 200 })
        : new Response("null", { status: 404 })));
    render(<PerformanceScorecard />);
    const read = await screen.findByTestId("performance-read");
    expect(read.textContent).toContain("Win rate is 67% across 3 decided trades.");
  });
});

// The server files every journal entry under JOURNAL (it used to be PAPER).
// When no entry has a recorded P/L the headline says the result is unknown,
// and the JOURNAL row of the environment table must say the same: "—", not
// a measured $0.00 or 0% win rate.
describe("Win/Loss Report environment row when P/L is unknown", () => {
  it("the JOURNAL row shows — for P/L and win rate when no entry has a recorded P/L", async () => {
    const body = {
      ...SCORECARD,
      environments: { ...SCORECARD.environments, JOURNAL: { ...SCORECARD.environments.JOURNAL, trades: 3, wins: 0, losses: 0, winRate: 0, pnl: 0 } },
      headline: { winRate: 0, totalPnl: 0, totalTrades: 3, tradesWithRecordedPnl: 0 },
      bestSymbol: null, worstSymbol: null,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/performance/scorecard")
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("null", { status: 404 })));
    render(<PerformanceScorecard />);
    expect((await screen.findByTestId("performance-read")).textContent).toMatch(/net result is unknown/);
    expect(screen.getByTestId("env-pnl-JOURNAL").textContent).toBe("—");
    expect(screen.getByTestId("env-winrate-JOURNAL").textContent).toBe("—");
    expect(screen.getByTestId("env-trades-JOURNAL").textContent).toBe("3");
  });

  it("the JOURNAL row keeps a recorded P/L and win rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/performance/scorecard")
        ? new Response(JSON.stringify({ ...SCORECARD, headline: { ...SCORECARD.headline, tradesWithRecordedPnl: 3 } }), { status: 200 })
        : new Response("null", { status: 404 })));
    render(<PerformanceScorecard />);
    await screen.findByTestId("performance-read");
    expect(screen.getByTestId("env-pnl-JOURNAL").textContent).toBe("+$20.00");
    expect(screen.getByTestId("env-winrate-JOURNAL").textContent).toBe("67%");
  });
});
