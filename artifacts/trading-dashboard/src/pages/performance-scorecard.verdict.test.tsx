import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import PerformanceScorecard from "@/pages/performance-scorecard";

// Regression: the Win/Loss Report said "You're net profitable across recorded
// trades" whenever totalPnl >= 0, and money() printed "+$0.00" for zero. The
// route sums (pnl ?? 0), so journal entries with no P/L filled in produced a
// positive verdict and a "+" sign for a result that was unknown, and an exact
// break-even read as "profitable".

function scorecard(headline: Record<string, unknown>) {
  return {
    environments: { PAPER: { trades: headline.totalTrades, wins: 0, losses: 0, winRate: 0, pnl: headline.totalPnl } },
    headline,
    bestSymbol: null, worstSymbol: null,
    strategyRanking: [], mistakeDistribution: {}, gradeDistribution: {},
    dataSource: "SIMULATOR_AND_TESTER_INTENTS", generatedAt: "2026-10-28T00:00:00Z",
  };
}

function stub(body: unknown) {
  global.fetch = vi.fn((url: string) =>
    Promise.resolve({
      ok: !String(url).includes("heat"),
      json: () => Promise.resolve(String(url).includes("heat") ? null : body),
    } as Response),
  ) as unknown as typeof fetch;
}

vi.mock("wouter", () => ({ useLocation: () => ["/performance-scorecard", vi.fn()] }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Win/Loss Report verdict", () => {
  it("entries with no recorded P/L do not read as net profitable", async () => {
    stub(scorecard({ winRate: 0, totalPnl: 0, totalTrades: 3, tradesWithRecordedPnl: 0 }));
    render(<PerformanceScorecard />);
    const read = await screen.findByTestId("performance-read");
    expect(read.textContent ?? "").not.toMatch(/net profitable/i);
    expect(read.textContent ?? "").toMatch(/no recorded P\/L/i);
    expect(screen.queryByText("+$0.00")).toBeNull();
  });

  it("an exact break-even is flat, not profitable, and carries no '+' sign", async () => {
    stub(scorecard({ winRate: 50, totalPnl: 0, totalTrades: 2, tradesWithRecordedPnl: 2 }));
    render(<PerformanceScorecard />);
    const read = await screen.findByTestId("performance-read");
    expect(read.textContent ?? "").not.toMatch(/net profitable/i);
    expect(read.textContent ?? "").toMatch(/flat/i);
    expect(screen.queryByText("+$0.00")).toBeNull();
  });

  it("a positive net P/L is still reported as net profitable", async () => {
    stub(scorecard({ winRate: 50, totalPnl: 12.5, totalTrades: 2, tradesWithRecordedPnl: 2 }));
    render(<PerformanceScorecard />);
    const read = await screen.findByTestId("performance-read");
    expect(read.textContent ?? "").toMatch(/net profitable/i);
  });

  it("discloses entries that have no P/L recorded yet", async () => {
    stub(scorecard({ winRate: 33, totalPnl: 12.5, totalTrades: 3, tradesWithRecordedPnl: 2 }));
    render(<PerformanceScorecard />);
    const read = await screen.findByTestId("performance-read");
    expect(read.textContent ?? "").toMatch(/1 of 3 journal entries has no P\/L recorded/i);
  });
});
