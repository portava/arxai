// Weekly review summary: the paragraph is rule-assembled from closed trades
// and journal tags, so the card does not call it an "AI weekly summary".
//
// The server reads only the legacy simulated-trade record (tradesTable), which
// is closed to new rows. The basis line must name that record and must not
// claim the summary covers "the trades you closed this week" — the user's
// paper, demo and live trades are not in it, which the performance card's
// source note on the same page says.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WeeklyReview } from "@workspace/api-client-react";
import { AIWeeklySummaryCard } from "./AIWeeklySummaryCard";
import { WeeklyPerformanceSummaryCard } from "./WeeklyPerformanceSummaryCard";

afterEach(() => cleanup());

// Copied from artifacts/api-server/src/routes/weeklyReviews.ts.
const WEEKLY_REVIEW_SOURCE_NOTE =
  "Performance figures come only from the legacy simulated-trade record, which has received no new trades since " +
  "the old execute-trade path was retired. Trades on your paper book, demo account and live account are not counted here.";
const WEEKLY_REVIEW_NOT_MEASURED_SUMMARY =
  "ARX could not measure this week's trading. This review reads only the legacy simulated-trade record, which had no closed " +
  "trades for this week; trades on your paper book, demo account and live account are not counted, so a zero here " +
  "does not mean you closed no trades.";

describe("Weekly summary card", () => {
  it("names what the summary is built from and does not claim AI authorship", () => {
    const r = {
      aiSummary: "Closed 1 trade: 1 winning, 0 losing.",
      nextWeekFocus: null,
      performanceSource: "LEGACY_TRADES_RECORD",
      performanceMeasured: true,
    } as unknown as WeeklyReview;
    render(<AIWeeklySummaryCard r={r} />);
    expect(screen.getByTestId("weekly-summary-title").textContent).toBe("Weekly summary");
    const basis = screen.getByTestId("weekly-summary-basis").textContent ?? "";
    expect(basis).toMatch(/fixed rules/);
    expect(basis).toMatch(/legacy simulated-trade record/);
    expect(basis).toMatch(/journal tags/);
    expect(basis).toMatch(/paper, demo and live trades are not/);
    expect(document.body.textContent).not.toMatch(/AI weekly summary/i);
  });

  it("does not claim to cover the trades you closed this week when the server reads only the legacy record", () => {
    const r = {
      weekStartIso: "2026-10-26T00:00:00.000Z",
      weekEndIso: "2026-11-01T23:59:59.999Z",
      totalTrades: 0,
      winRate: 0,
      averageRr: 0,
      netProfitLoss: 0,
      aiSummary: WEEKLY_REVIEW_NOT_MEASURED_SUMMARY,
      nextWeekFocus: null,
      performanceSource: "LEGACY_TRADES_RECORD",
      performanceMeasured: false,
      performanceSourceNote: WEEKLY_REVIEW_SOURCE_NOTE,
    } as unknown as WeeklyReview;
    render(
      <>
        <WeeklyPerformanceSummaryCard r={r} />
        <AIWeeklySummaryCard r={r} />
      </>,
    );
    const basis = screen.getByTestId("weekly-summary-basis").textContent ?? "";
    expect(basis).not.toMatch(/trades you closed this week/i);
    expect(basis).toMatch(/legacy simulated-trade record/);
    expect(screen.getByTestId("weekly-performance-source").textContent).toMatch(/legacy simulated-trade record/);
  });

  it("does not name a source the server did not report", () => {
    const r = { aiSummary: "Closed 1 trade.", nextWeekFocus: null } as unknown as WeeklyReview;
    render(<AIWeeklySummaryCard r={r} />);
    const basis = screen.getByTestId("weekly-summary-basis").textContent ?? "";
    expect(basis).not.toMatch(/trades you closed this week/i);
    expect(basis).toMatch(/not reported/);
  });
});
