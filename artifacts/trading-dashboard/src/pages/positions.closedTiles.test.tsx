// Regression (review of f509a058, which relabelled the tiles "closed"): with
// open simulator positions and none closed, /oms/pnl/summary returns winRate
// 0, averageR 0 and maxDrawdown 0, and the page printed "Win rate (closed)
// 0%", "Avg R (closed) 0", "Max DD (closed) $0.00" — figures nobody measured.
// "Sim realized today" summed the UTC calendar day without saying so.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const { default: PositionsPage } = await import("./positions");

const pnl = {
  environment: "ALL", dailyPnL: 0, weeklyPnL: 0, monthlyPnL: 0, openUnrealizedPnL: 3.2, closedRealizedPnL: 0,
  wins: 0, losses: 0, winRate: 0, averageR: 0, maxDrawdown: 0, dataSource: "SIMULATOR",
};
function stubFetch(summary: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).startsWith("/api/oms/positions")) return new Response(JSON.stringify({ positions: [], dataSource: "SIMULATOR" }), { status: 200 });
    if (String(url).startsWith("/api/pnl/summary")) return new Response(JSON.stringify(summary), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }));
}
const tiles = () => screen.getByTestId("positions-pnl-tiles").textContent ?? "";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Positions page — closed-trade tiles with nothing closed", () => {
  it("says the closed-trade figures were not measured instead of 0% / 0 / $0.00", async () => {
    stubFetch({ ...pnl, closedCount: 0, dayBoundary: "UTC" });
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByTestId("positions-pnl-tiles")).toBeTruthy());
    expect(tiles()).not.toMatch(/Win rate \(closed\)0%/);
    expect(tiles()).not.toMatch(/Avg R \(closed\)0(?!\.)/);
    expect(tiles()).not.toMatch(/Max DD \(closed\)\$0\.00/);
    expect(screen.getAllByText("Not measured").length).toBe(3);
  });

  it("an older server without closedCount: wins + losses of 0 is treated as not measured too", async () => {
    stubFetch(pnl);
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByTestId("positions-pnl-tiles")).toBeTruthy());
    expect(screen.getAllByText("Not measured").length).toBe(3);
  });

  it("labels today's realized P/L as the UTC day", async () => {
    stubFetch({ ...pnl, closedCount: 0, dayBoundary: "UTC" });
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByTestId("positions-pnl-tiles")).toBeTruthy());
    expect(tiles()).toMatch(/Sim realized today \(UTC\)/);
    expect(tiles()).toMatch(/since 00:00 UTC/);
  });

  it("with closed positions, the measured figures are shown", async () => {
    stubFetch({ ...pnl, wins: 1, losses: 1, winRate: 50, averageR: 0.4, maxDrawdown: -12, closedCount: 2 });
    render(<PositionsPage />);
    await waitFor(() => expect(screen.getByTestId("positions-pnl-tiles")).toBeTruthy());
    expect(screen.queryByText("Not measured")).toBeNull();
    expect(tiles()).toMatch(/50%/);
    expect(tiles()).toMatch(/-\$12\.00/);
  });
});
