// Truth: the near-stop-loss alert is raised for a live_positions row (the DEMO
// / legacy EA mirror). Its "Open" link went to /portfolio, which reads only the
// legacy trades table and showed "Open Trades 0". The link now goes to My
// Trades, the page that lists the trader's DEMO-venue open positions.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AlertDetailCard } from "./AlertDetailCard";

afterEach(() => cleanup());

const base = {
  id: 9, severity: "warning", priority: "HIGH", read: 0, createdAt: "2026-10-28T11:40:00Z",
  title: "Demo position near stop loss: EURUSD",
  message: "Demo position #41 (BUY EURUSD) has 10% of its stop-loss distance left at the last recorded price 1.091 (sync time not recorded).",
};

describe("AlertDetailCard position links", () => {
  it("a near-stop alert on a DEMO-venue row opens My Trades, not Portfolio", () => {
    render(<AlertDetailCard alert={{ ...base, type: "POSITION_WARNING", relatedPositionId: 41, relatedTradeId: 5 }} onMarkRead={() => {}} />);
    const link = screen.getByTestId("button-alert-open-9").closest("a");
    expect(link?.getAttribute("href")).toBe("/my-trades");
  });

  it("a position warning with no related position offers no link to a page that cannot show it", () => {
    render(<AlertDetailCard alert={{ ...base, type: "POSITION_WARNING", title: "Live position mismatch" }} onMarkRead={() => {}} />);
    expect(screen.queryByTestId("button-alert-open-9")).toBeNull();
  });
});
