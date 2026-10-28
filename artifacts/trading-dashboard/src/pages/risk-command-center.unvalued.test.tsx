// Risk Command Center: every null money value read "none set". With the
// default 3% daily cap and unknown equity (no account read) the server could
// not value the cap, so Daily limit, Daily risk left and Equity all said
// "none set" under a green OK, although a cap is set and equity is unknown,
// not "not set".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { default: RiskCommandCenter } = await import("./risk-command-center");

const profile = {
  preset: "CUSTOM", presets: [],
  settings: { maxRiskPerTradeAmount: null, maxDailyLossAmount: null, maxPositionSize: null, minRewardRiskRatio: 1.5, maxTradesPerDay: 10, maxOpenTrades: 3 },
  effectiveLimits: { maxLotSize: 1, maxDailyLossPercent: 3, maxDailyLossAmount: null, maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, discipline: { maxTradesPerDay: 10, maxOpenTrades: 3 } },
};
const reason = "Your 3% daily loss cap cannot be valued because account equity is unknown.";
const budget = {
  venue: "PAPER", dailyRiskLimit: null, dailyRiskUsed: 0, dailyRiskRemaining: null, weeklyRiskLimit: null, weeklyRiskUsed: 0,
  weeklyRiskRemaining: null, openRisk: 0, openPositions: 0, equity: null, riskStatus: "UNKNOWN",
  equityKnown: false, dailyRiskLimitUnvalued: true, weeklyRiskLimitUnvalued: false, riskStatusReason: reason,
};
const cards = {
  venue: "PAPER", riskStatus: "UNKNOWN", riskStatusReason: reason, dailyRiskRemaining: null, weeklyRiskRemaining: null,
  dailyRiskLimitUnvalued: true, weeklyRiskLimitUnvalued: false, equityKnown: false,
  openRisk: 0, openPositions: 0, tradesToday: 0, consecutiveLosses: 0, overtrading: "NORMAL", activeHalts: [],
  permissions: { trading: true, pauseReason: null }, propFirm: null,
};

function stub(b: Record<string, unknown>, c: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes("/api/risk/budget") ? b : u.includes("/api/risk/dashboard-cards") ? c : profile;
    return { ok: true, status: 200, json: async () => body };
  }));
}

const statValue = (label: string) => screen.getByText(label).parentElement?.querySelector("p:last-child")?.textContent ?? "";

beforeEach(() => { try { window.localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Risk Command Center null money values", () => {
  it("Summary: an unvalued daily cap is not 'none set', and the status says why it is unknown", async () => {
    stub(budget, cards);
    render(<RiskCommandCenter />);
    await screen.findByText("Daily risk left");
    expect(screen.queryByText("none set")).toBeNull();
    expect(statValue("Daily risk left")).toMatch(/unknown/i);
    expect(statValue("Weekly risk left")).toMatch(/no cap set/i);
    expect(screen.getByTestId("risk-status-badge").textContent).toBe("UNKNOWN");
    expect(screen.getByTestId("risk-status-reason").textContent).toContain(reason);
  });

  it("Limits: Daily limit is a cap that cannot be valued and Equity is unknown, not 'none set'", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "limits");
    stub(budget, cards);
    render(<RiskCommandCenter />);
    await screen.findByText("Daily limit");
    expect(screen.queryByText("none set")).toBeNull();
    expect(statValue("Daily limit")).toMatch(/3%.*equity unknown/i);
    expect(statValue("Equity")).toMatch(/unknown/i);
    expect(statValue("Weekly limit")).toMatch(/no cap set/i);
  });

  it("an amount cap with an unvalued percent cap is shown as an upper bound", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "limits");
    stub({ ...budget, dailyRiskLimit: 200, dailyRiskRemaining: 200 }, cards);
    render(<RiskCommandCenter />);
    await screen.findByText("Daily limit");
    expect(statValue("Daily limit")).toMatch(/\$200 or less/);
  });

  it("a response without the flags never claims 'none set' for a null", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "limits");
    const { equityKnown: _e, dailyRiskLimitUnvalued: _d, weeklyRiskLimitUnvalued: _w, riskStatusReason: _r, ...legacy } = budget;
    stub({ ...legacy, riskStatus: "OK" }, cards);
    render(<RiskCommandCenter />);
    await screen.findByText("Daily limit");
    expect(screen.queryByText("none set")).toBeNull();
    expect(statValue("Daily limit")).toMatch(/not reported/i);
    expect(statValue("Equity")).toMatch(/unknown/i);
  });
});
