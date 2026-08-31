// Truth contract for the Session Heatmap:
//   - a failed/absent read renders a labeled unknown, NEVER a "$0 / 0 trades /
//     0% win" grid (which is indistinguishable from a real flat result);
//   - a session bucket with zero trades renders "No trades" + "—", never a
//     confident "0% win" over no measurement;
//   - real buckets still render their measured figures;
//   - P/L is a SYNTHETIC unit ((exit − entry) × lots × 100) — it is NEVER
//     rendered with a "$" sign, and the grid carries an explicit unit +
//     data-window caption.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SessionHeatmap, fmtSyntheticPnl } from "./SessionHeatmap";

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
    // \b matters: an unanchored /0% win/ also matches the TAIL of the measured
    // session's legitimate "50% win", so the original assertion failed against
    // correct output. Only a win-rate that is literally zero must be absent.
    expect(screen.queryByText(/\b0% win/)).toBeNull();
    expect(screen.getAllByText("No trades")).toHaveLength(2);
    // The measured session still shows its real figures — in synthetic units,
    // never with a fabricated "$" sign.
    expect(screen.getByText("-30")).toBeTruthy();
    expect(screen.getByText(/2 trades · 50% win/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\$-?\d/);
  });

  it("labels the unit (synthetic, not account currency) and the data window", () => {
    render(
      <SessionHeatmap
        data={{
          ASIA: { trades: 3, pnl: 12, wins: 2 },
          LONDON: { trades: 2, pnl: -30, wins: 1 },
          NEWYORK: { trades: 0, pnl: 0, wins: 0 },
        }}
      />,
    );
    const caption = screen.getByTestId("session-heatmap-caption");
    expect(caption.textContent).toMatch(/synthetic units/i);
    expect(caption.textContent).toMatch(/not account currency/i);
    // Window caption counts the closed trades actually aggregated (3 + 2).
    expect(caption.textContent).toMatch(/5 most recent\s+closed paper trades/);
  });

  it("keeps tiny FX-scale synthetic P/L visible instead of collapsing to 0", () => {
    // 10-pip EURUSD win at 0.01 lots = 0.001 synthetic units; "$0" was the old
    // fabricated render. Two decimals keep the magnitude class honest, and a
    // dollar sign never appears.
    expect(fmtSyntheticPnl(0.001)).toBe("0.00");
    expect(fmtSyntheticPnl(-3.456)).toBe("-3.46");
    expect(fmtSyntheticPnl(340)).toBe("340");
    render(<SessionHeatmap data={{ ASIA: { trades: 1, pnl: 0.001, wins: 1 } }} />);
    expect(document.body.textContent).not.toContain("$");
  });
});
