// Session Heatmap truth: GET /api/analytics/session sums `pnl` only over the
// trades in a session that could be sized in USD and says how many with
// `sizedTrades` (routes/analytics.ts buildAllHeatmaps). A session whose trades
// could not be sized (XAUUSD with no contract spec, say) carries pnl 0; it
// must not read as a green "$0" break-even result next to "100% win".
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionHeatmap } from "./SessionHeatmap";

afterEach(() => cleanup());

// Each tile is the element that holds the session name.
const tile = (s: string) => screen.getByText(s).parentElement as HTMLElement;

describe("SessionHeatmap", () => {
  it("a session with trades but none sized reads 'not measured' in a neutral tone, not a green $0", () => {
    render(<SessionHeatmap data={{
      ASIA: { trades: 1, pnl: 0, wins: 1, sizedTrades: 0 },
      LONDON: { trades: 2, pnl: 150, wins: 1, sizedTrades: 2 },
      NEWYORK: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
    }} />);
    const asia = tile("ASIA");
    expect(asia.textContent).toMatch(/not measured/i);
    expect(asia.textContent).not.toMatch(/\$0/);
    expect(asia.innerHTML).not.toMatch(/emerald|rgba\(16,185,129/);
    expect(asia.getAttribute("style") ?? "").not.toMatch(/16,\s*185,\s*129/);
    // The win count is by price move, so it is still a measured figure.
    expect(asia.textContent).toMatch(/1 trades/);
    // The sized session keeps its figure.
    expect(tile("LONDON").textContent).toContain("$150");
    expect(tile("LONDON").textContent).not.toMatch(/sized/);
  });

  it("a session with some trades unsized says how many of its trades the figure covers", () => {
    render(<SessionHeatmap data={{
      ASIA: { trades: 3, pnl: 40, wins: 2, sizedTrades: 2 },
      LONDON: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
      NEWYORK: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
    }} />);
    expect(tile("ASIA").textContent).toContain("$40");
    expect(tile("ASIA").textContent).toMatch(/2 of 3 trades sized/);
  });

  it("a session with no trades shows no P&L and no win rate", () => {
    render(<SessionHeatmap data={{
      ASIA: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
      LONDON: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
      NEWYORK: { trades: 0, pnl: 0, wins: 0, sizedTrades: 0 },
    }} />);
    const ny = tile("NEWYORK");
    expect(ny.textContent).toMatch(/no trades/i);
    expect(ny.textContent).not.toMatch(/\$0|0% win/);
  });
});
