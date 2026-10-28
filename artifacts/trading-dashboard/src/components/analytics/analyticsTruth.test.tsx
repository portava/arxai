// Analytics Command Center components: a cell with nothing measured says so
// ("No trades", "—"), never a $0 or a 0% result.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionHeatmap } from "./SessionHeatmap";

afterEach(() => { cleanup(); });

describe("SessionHeatmap", () => {
  it("a session with no trades shows 'No trades' and —, not $0 and 0% win", () => {
    render(<SessionHeatmap data={{
      ASIA: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
      LONDON: { trades: 2, pnl: 150, wins: 1, sizedTrades: 2 },
      NEWYORK: { trades: 1, pnl: 0, wins: 1, sizedTrades: 0 },
    }} basis="Sessions are by each trade's open time in UTC: ASIA 21:00–07:00 (Sydney and Tokyo), LONDON 07:00–13:00, NEWYORK 13:00–21:00." />);
    const asia = screen.getByTestId("session-cell-ASIA").textContent ?? "";
    expect(asia).toContain("No trades");
    expect(asia).toContain("—");
    expect(asia).not.toMatch(/0% win|\$0/);
    const london = screen.getByTestId("session-cell-LONDON").textContent ?? "";
    expect(london).toContain("$150");
    expect(london).toContain("2 trades · 50% win");
    // Traded, but nothing could be sized in USD: no $0 P&L.
    const ny = screen.getByTestId("session-cell-NEWYORK").textContent ?? "";
    expect(ny).not.toContain("$0");
    expect(ny).toContain("P&L not sized");
    expect(screen.getByTestId("session-basis").textContent).toMatch(/NEWYORK 13:00–21:00/);
  });
});
