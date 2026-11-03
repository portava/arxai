// Risk Command Center: the Risk Governor counts closed paper trades at the
// lower of their booked total and their paper risk model total (price move ×
// lots × 100), so "Daily used", "Daily risk left" and the equity a percent cap is valued on
// can differ from the booked P&L and equity on the paper account. The page
// showed those figures with no word that they are a conservative count. It
// now shows the server's note, with both figures, when they differ.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { default: RiskCommandCenter } = await import("./risk-command-center");

const profile = {
  preset: "CUSTOM", presets: [],
  settings: { maxRiskPerTradeAmount: null, maxDailyLossAmount: null, maxPositionSize: null, minRewardRiskRatio: 1.5, maxTradesPerDay: 10, maxOpenTrades: 3 },
  effectiveLimits: { maxLotSize: 1, maxDailyLossPercent: 5, maxDailyLossAmount: null, maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, discipline: { maxTradesPerDay: 10, maxOpenTrades: 3 } },
};
const note = "For your loss limits today's realized paper P&L is counted as -$499.90 (booked $95.00), and equity is counted as $9,500.10 (the paper account shows $10,095.00). The Risk Governor counts closed paper trades at the lower of two totals over the same trades, their booked P&L and the paper risk model (price move × lots × 100), and each open position at the lower of its sized value and the paper risk model at the paper venue's current price, never above the floating P&L the account shows, so a limit is never checked against a smaller loss or a larger equity than either basis gives.";
const budget = {
  venue: "PAPER", dailyRiskLimit: 475.01, dailyRiskUsed: 499.9, dailyRiskRemaining: -24.89, weeklyRiskLimit: null, weeklyRiskUsed: 499.9,
  weeklyRiskRemaining: null, openRisk: 0, openPositions: 0, equity: 9500.1, riskStatus: "BLOCK",
  equityKnown: true, dailyRiskLimitUnvalued: false, weeklyRiskLimitUnvalued: false, riskStatusReason: null,
  dailyRiskUsedKnown: true, dailyRiskUsedUnknownReason: null, weeklyRiskUsedKnown: true, weeklyRiskUsedUnknownReason: null,
  riskCountNote: note,
};
const cards = {
  venue: "PAPER", riskStatus: "BLOCK", riskStatusReason: null, dailyRiskRemaining: -24.89, weeklyRiskRemaining: null,
  dailyRiskLimitUnvalued: false, weeklyRiskLimitUnvalued: false, equityKnown: true,
  dailyRiskUsedKnown: true, dailyRiskUsedUnknownReason: null, weeklyRiskUsedKnown: true, weeklyRiskUsedUnknownReason: null,
  openRisk: 0, openPositions: 0, tradesToday: 2, consecutiveLosses: 0, overtrading: "NORMAL", activeHalts: [],
  permissions: { trading: false, pauseReason: null, blockedBy: ["daily_loss_limit"] }, propFirm: null,
  riskCountNote: note,
};

function stub(b: Record<string, unknown>, c: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes("/api/risk/budget") ? b : u.includes("/api/risk/dashboard-cards") ? c : profile;
    return { ok: true, status: 200, json: async () => body };
  }));
}

beforeEach(() => { try { window.localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Risk Command Center paper risk count", () => {
  it("Summary: says the daily figures are a conservative count, with the booked figures", async () => {
    stub(budget, cards);
    render(<RiskCommandCenter />);
    await screen.findByText("Daily risk left");
    expect(screen.getByTestId("risk-count-note").textContent).toBe(note);
  });

  it("Limits: the Risk Budget card shows the note under Daily used and Equity", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "limits");
    stub(budget, cards);
    render(<RiskCommandCenter />);
    await screen.findByText("Daily used");
    expect(screen.getByTestId("risk-budget-count-note").textContent).toBe(note);
  });

  it("no note when the count matches the booked figures (or an older server)", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "limits");
    const { riskCountNote: _b, ...b } = budget;
    const { riskCountNote: _c, ...c } = cards;
    stub(b, { ...c, riskCountNote: null });
    render(<RiskCommandCenter />);
    await screen.findByText("Daily used");
    expect(screen.queryByTestId("risk-budget-count-note")).toBeNull();
    expect(screen.queryByTestId("risk-count-note")).toBeNull();
  });
});
