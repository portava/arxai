import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WeeklyReview } from "@workspace/api-client-react";
import { WeeklyPerformanceSummaryCard } from "./WeeklyPerformanceSummaryCard";

// The weekly review reads only the legacy simulated-trade record, which is
// closed to new rows. When the server says that source had nothing for the
// week (performanceMeasured false), "Trades 0 · Win rate 0% · Net P/L +0.00"
// would present an unmeasured week as a measured, empty one.

const base: WeeklyReview = {
  id: 1, weekStartIso: "2026-10-26T00:00:00.000Z", weekEndIso: "2026-11-01T23:59:59.999Z",
  totalTrades: 0, winningTrades: 0, losingTrades: 0, netProfitLoss: 0, winRate: 0, averageRr: 0,
  createdAtIso: "2026-10-28T10:00:00.000Z",
  performanceSource: "LEGACY_TRADES_RECORD",
  performanceMeasured: false,
  performanceSourceNote: "Performance figures come only from the legacy simulated-trade record.",
};

afterEach(cleanup);

describe("WeeklyPerformanceSummaryCard", () => {
  it("does not show zeros as this week's result when the server says it was not measured", () => {
    render(<WeeklyPerformanceSummaryCard r={base} />);
    expect(screen.queryByText("0%")).toBeNull();
    expect(screen.queryByText("+0.00")).toBeNull();
    expect(screen.queryByText("0.00")).toBeNull();
    expect(screen.getByTestId("weekly-performance-not-measured").textContent).toMatch(/Not measured/);
    expect(screen.getByTestId("weekly-performance-source").textContent).toMatch(/legacy simulated-trade record/);
  });

  it("shows the measured figures when the source had trades", () => {
    render(<WeeklyPerformanceSummaryCard r={{ ...base, totalTrades: 2, winningTrades: 1, losingTrades: 1, winRate: 0.5, averageRr: 1.5, netProfitLoss: 4.25, performanceMeasured: true }} />);
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("+4.25")).toBeTruthy();
    expect(screen.queryByTestId("weekly-performance-not-measured")).toBeNull();
  });
});
