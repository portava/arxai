// Truth regression: the deep-history badge describes what it actually knows.
//  - coverageDays is the SERVER CACHE span (oldest..newest cached rows), not
//    the bars the chart holds, so it is labelled "cached", never "Xd history".
//  - a failed back-page is reported plainly instead of "History loaded".
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChartHistoryBadge } from "./ChartHistoryBadge";

afterEach(cleanup);

const base = {
  loading: false,
  hasMore: true,
  providerCapped: false,
  limitationReason: null,
  coverageDays: null,
  depthTargetDays: 90,
  loadedAny: false,
};

describe("ChartHistoryBadge", () => {
  it("labels server cache coverage as cached, not as chart history", () => {
    render(<ChartHistoryBadge {...base} coverageDays={90} loadedAny />);
    const chip = screen.getByTestId("chart-history-depth");
    expect(chip.textContent).not.toMatch(/90d history/);
    expect(chip.textContent).toContain("90d cached");
    expect(chip.getAttribute("title") ?? "").toMatch(/server cache/i);
  });

  it("reports a failed back-page instead of 'History loaded'", () => {
    render(<ChartHistoryBadge {...base} hasMore={false} loadError="Older history could not be loaded; scroll-back paging stopped." />);
    expect(screen.queryByText(/History loaded/)).toBeNull();
    expect(screen.getByTestId("chart-history-error").textContent).toContain("could not be loaded");
  });
});
