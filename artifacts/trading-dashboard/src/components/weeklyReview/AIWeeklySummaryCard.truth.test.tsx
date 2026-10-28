// Weekly review summary: the paragraph is rule-assembled from closed trades
// and journal tags, so the card does not call it an "AI weekly summary".
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WeeklyReview } from "@workspace/api-client-react";
import { AIWeeklySummaryCard } from "./AIWeeklySummaryCard";

afterEach(() => cleanup());

describe("Weekly summary card", () => {
  it("names what the summary is built from and does not claim AI authorship", () => {
    const r = { aiSummary: "Closed 1 trade: 1 winning, 0 losing.", nextWeekFocus: null } as unknown as WeeklyReview;
    render(<AIWeeklySummaryCard r={r} />);
    expect(screen.getByTestId("weekly-summary-title").textContent).toBe("Weekly summary");
    expect(screen.getByTestId("weekly-summary-basis").textContent).toMatch(/trades you closed this week/);
    expect(document.body.textContent).not.toMatch(/AI weekly summary/i);
  });
});
