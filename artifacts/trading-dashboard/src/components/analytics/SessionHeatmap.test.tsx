// Truth contract for the Session Heatmap:
//   - a failed/absent read renders a labeled unknown, NEVER a "$0 / 0 trades /
//     0% win" grid (which is indistinguishable from a real flat result);
//   - a session bucket with zero trades renders "No trades" + "—", never a
//     confident "0% win" over no measurement;
//   - real buckets still render their measured figures.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionHeatmap } from "./SessionHeatmap";

afterEach(cleanup);

describe("SessionHeatmap", () => {
  it("renders the error state (not a $0 grid) when data is null", () => {
    render(<SessionHeatmap data={null} />);
    expect(screen.getByTestId("session-heatmap-error")).toBeTruthy();
    expect(screen.queryByText(/\$0\b/)).toBeNull();
    expect(screen.queryByText(/% win/)).toBeNull();
  });

  it("renders the error state when isError is set, even with data present", () => {
    render(<SessionHeatmap data={{ ASIA: { trades: 1, pnl: 5, wins: 1 } }} isError />);
    expect(screen.getByTestId("session-heatmap-error")).toBeTruthy();
    expect(screen.queryByText(/1 trades/)).toBeNull();
  });

  it("renders the loading state while pending", () => {
    render(<SessionHeatmap data={null} isLoading />);
    expect(screen.getByTestId("session-heatmap-loading")).toBeTruthy();
    expect(screen.queryByTestId("session-heatmap-error")).toBeNull();
  });

  it("renders '—' / 'No trades' for a zero-trade session, never '0% win'", () => {
    render(
      <SessionHeatmap
        data={{
          ASIA: { trades: 0, pnl: 0, wins: 0 },
          LONDON: { trades: 2, pnl: -30, wins: 1 },
          NEWYORK: { trades: 0, pnl: 0, wins: 0 },
        }}
      />,
    );
    expect(screen.getByTestId("session-empty-ASIA")).toBeTruthy();
    expect(screen.getByTestId("session-empty-NEWYORK")).toBeTruthy();
    expect(screen.queryByText(/0% win/)).toBeNull();
    expect(screen.getAllByText("No trades")).toHaveLength(2);
    // The measured session still shows its real figures.
    expect(screen.getByText("$-30")).toBeTruthy();
    expect(screen.getByText(/2 trades · 50% win/)).toBeTruthy();
  });
});
