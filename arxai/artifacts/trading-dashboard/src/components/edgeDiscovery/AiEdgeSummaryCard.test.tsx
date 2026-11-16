import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AiEdgeSummaryCard } from "./AiEdgeSummaryCard";
import type { EdgeReport } from "./types";

const report: EdgeReport = {
  id: 9, edgeName: "symbol=EURUSD", symbol: "EURUSD", strategyId: null, timeframe: null, sessionName: null,
  marketCondition: null, sampleSize: 3, winRate: 0.66, averageRr: 0, expectancy: 1, profitFactor: 2,
  disciplineScoreAvg: 0, executionScoreAvg: 0, emotionalScoreAvg: 0, confidenceScore: 9,
  status: "INSUFFICIENT_DATA", aiSummary: "EURUSD: not enough data yet.", createdAt: "2026-10-27T10:00:00Z",
};
afterEach(() => cleanup());

describe("AiEdgeSummaryCard behaviour scores", () => {
  it("does not print 0 scores when no debrief was linked to the slice", () => {
    const { container } = render(<AiEdgeSummaryCard report={report} behaviourBasis="NOT_MEASURED" />);
    expect(container.querySelectorAll("dd").length).toBe(3);
    for (const dd of Array.from(container.querySelectorAll("dd"))) expect(dd.textContent).toBe("Not measured");
    expect(screen.getByText(/behaviour was not measured/)).toBeTruthy();
  });

  it("treats an older (or unlabelled) report's account-wide numbers as not this slice's", () => {
    const { container } = render(<AiEdgeSummaryCard report={{ ...report, disciplineScoreAvg: 67, emotionalScoreAvg: 67, executionScoreAvg: 67 }} />);
    expect(container.textContent).not.toContain("67");
    expect(screen.getByText(/not this slice/)).toBeTruthy();
  });

  it("shows per-slice discipline/emotional scores, never an execution score", () => {
    const { container } = render(<AiEdgeSummaryCard report={{ ...report, disciplineScoreAvg: 100, emotionalScoreAvg: 50, executionScoreAvg: 75 }} behaviourBasis="SLICE_DEBRIEFS" />);
    const dds = Array.from(container.querySelectorAll("dd")).map((d) => d.textContent);
    expect(dds).toEqual(["100", "Not measured", "50"]);
  });
});
