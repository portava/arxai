import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

// The Rules tab ("Whether your account can open new trades right now") showed
// a default-styled "trading: true" while the header badge said BLOCK: the
// daily loss limit was reached and only the stop switches fed `trading`.
// It now says in words what stops new trades, and only ever downgrades.

const { default: RiskCommandCenter } = await import("./risk-command-center");

const PROFILE = {
  preset: "CUSTOM", settings: { minRewardRiskRatio: 1.5 },
  effectiveLimits: { maxLotSize: 1, maxDailyLossPercent: null, maxDailyLossAmount: 100, maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, discipline: { maxTradesPerDay: null, maxOpenTrades: 3 } },
};
const BUDGET = { venue: "PAPER", dailyRiskLimit: 100, dailyRiskUsed: 120, dailyRiskRemaining: -20, weeklyRiskLimit: null, weeklyRiskUsed: 0, openRisk: 0, openPositions: 0, equity: 10000, riskStatus: "BLOCK" };
function cards(over: Record<string, unknown>) {
  return {
    venue: "PAPER", riskStatus: "BLOCK", dailyRiskRemaining: -20, weeklyRiskRemaining: null, openRisk: 0, openPositions: 0,
    tradesToday: 2, consecutiveLosses: 1, overtrading: "NORMAL", activeHalts: [], propFirm: null,
    permissions: { trading: true, pauseReason: null }, ...over,
  };
}

function stub(c: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/risk-profile") ? PROFILE : url.includes("/risk/budget") ? BUDGET : c;
    return { ok: true, status: 200, json: async () => body };
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe("Risk Command Center — Rules tab permissions", () => {
  it("a BLOCK status with an older server's trading:true reads 'New trades: blocked', never 'trading: true'", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "rules");
    stub(cards({ permissions: { trading: true, pauseReason: null } }));
    render(<RiskCommandCenter />);
    const row = await screen.findByTestId("risk-perm-new-trades");
    expect(row.textContent).toMatch(/New trades: blocked/);
    expect(row.textContent).toMatch(/loss limit is reached/);
    expect(screen.queryByText(/trading: true/)).toBeNull();
  });

  it("names the daily loss limit when the server says so", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "rules");
    stub(cards({ permissions: { trading: false, pauseReason: null, stopSwitchEngaged: false, blockedBy: ["daily_loss_limit"] } }));
    render(<RiskCommandCenter />);
    const row = await screen.findByTestId("risk-perm-new-trades");
    expect(within(row).getByText("Your daily loss limit is reached")).toBeTruthy();
  });

  it("nothing blocking says so without claiming approval", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "rules");
    stub(cards({ riskStatus: "OK", dailyRiskRemaining: 90, permissions: { trading: true, pauseReason: null, stopSwitchEngaged: false, blockedBy: [] } }));
    render(<RiskCommandCenter />);
    const row = await screen.findByTestId("risk-perm-new-trades");
    expect(row.textContent).toMatch(/not blocked by a stop switch or loss limit/);
    expect(row.textContent).toMatch(/still checked by the Risk Governor/);
  });
});
