// Regression: "Trades: 4 (2W/1L/0BE)" did not sum because a close without a
// recorded result vanished from the breakdown, and an un-ended session's
// duration (computed to "now") had no "so far" marker.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import SessionReport from "./session-report";

function stub(report: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/paper-sessions?")) {
      return new Response(JSON.stringify({ sessions: [{ paper_session_id: "ps_1", status: "ACTIVE" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ report }), { status: 200 });
  }));
}
const base = {
  session_report_id: "psrpt_1", paper_session_id: "ps_1", status: "PARTIAL",
  duration_minutes: 42, total_trades: 4, wins: 2, losses: 1, break_even: 0,
  net_pnl: 150, win_rate: 67, rule_violations: [], mistakes_detected: [], lessons_generated: [],
  coach_summary: "", next_best_actions: [], warnings: [],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("session report outcome breakdown", () => {
  it("shows the result-less close as unclassified and marks a running duration", async () => {
    stub({ ...base, unclassified: 1, duration_in_progress: true });
    render(<SessionReport />);
    await waitFor(() => expect(screen.getByText(/Trades: 4/)).toBeTruthy());
    expect(screen.getByText(/2W\/1L\/0BE, 1 unclassified/)).toBeTruthy();
    expect(screen.getByText(/42m so far/)).toBeTruthy();
    expect(screen.getByText(/67% of 3 with a recorded result/)).toBeTruthy();
  });

  it("derives the unclassified count from an older server's counts", async () => {
    stub({ ...base, status: "COMPLETE" });
    render(<SessionReport />);
    await waitFor(() => expect(screen.getByText(/Trades: 4/)).toBeTruthy());
    expect(screen.getByText(/1 unclassified/)).toBeTruthy();
    expect(screen.queryByText(/so far/)).toBeNull();
  });

  it("says win rate is not available when no close has a result", async () => {
    stub({ ...base, total_trades: 1, wins: 0, losses: 0, win_rate: null, unclassified: 1 });
    render(<SessionReport />);
    await waitFor(() => expect(screen.getByText(/Trades: 1/)).toBeTruthy());
    expect(screen.getByText(/Win rate: not available/)).toBeTruthy();
    expect(screen.queryByText(/Win rate: 0%/)).toBeNull();
  });
});
