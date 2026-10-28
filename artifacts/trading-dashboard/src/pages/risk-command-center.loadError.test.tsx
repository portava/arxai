// Risk Command Center: the page never checked response.ok. A JSON error body
// (401 {error}) was stored as the dashboard cards and the render then threw
// on `cards.permissions.pauseReason`; a rejected poll left the previous
// figures on screen as current with no age or error; a first-load failure
// left the tabs blank with no "could not be loaded".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { default: RiskCommandCenter } = await import("./risk-command-center");

const profile = {
  preset: "CUSTOM", presets: [],
  settings: { maxRiskPerTradeAmount: null, maxDailyLossAmount: 200, maxPositionSize: null, minRewardRiskRatio: 1.5, maxTradesPerDay: 10, maxOpenTrades: 3 },
  effectiveLimits: { maxLotSize: 1, maxDailyLossPercent: null, maxDailyLossAmount: 200, maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, discipline: { maxTradesPerDay: 10, maxOpenTrades: 3 } },
};
const budget = {
  venue: "PAPER", dailyRiskLimit: 200, dailyRiskUsed: 0, dailyRiskRemaining: 200, weeklyRiskLimit: null, weeklyRiskUsed: 0,
  weeklyRiskRemaining: null, openRisk: 0, openPositions: 0, equity: 10_000, riskStatus: "OK",
  equityKnown: true, dailyRiskLimitUnvalued: false, weeklyRiskLimitUnvalued: false, riskStatusReason: null,
};
const cards = {
  venue: "PAPER", riskStatus: "OK", riskStatusReason: null, dailyRiskRemaining: 200, weeklyRiskRemaining: null,
  dailyRiskLimitUnvalued: false, weeklyRiskLimitUnvalued: false, equityKnown: true,
  openRisk: 0, openPositions: 0, tradesToday: 1, consecutiveLosses: 0, overtrading: "NORMAL", activeHalts: [],
  permissions: { trading: true, pauseReason: null }, propFirm: null,
};

const okBody = (u: string) => (u.includes("/api/risk/budget") ? budget : u.includes("/api/risk/dashboard-cards") ? cards : profile);

beforeEach(() => { try { window.localStorage.clear(); } catch { /* ignore */ } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Risk Command Center failed reads", () => {
  it("a 401 JSON error from dashboard-cards is shown as 'could not be loaded', not stored as cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/risk/dashboard-cards")) return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
      return { ok: true, status: 200, json: async () => okBody(u) };
    }));
    render(<RiskCommandCenter />);
    const alert = await screen.findByTestId("risk-load-error");
    expect(alert.textContent).toMatch(/could not be loaded/i);
    expect(alert.textContent).toMatch(/unauthorized/);
    expect(screen.queryByText("Daily risk left")).toBeNull();
  });

  it("a non-JSON 500 on first load says the data could not be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError("Unexpected token <"); } })));
    render(<RiskCommandCenter />);
    const alert = await screen.findByTestId("risk-load-error");
    expect(alert.textContent).toMatch(/could not be loaded/i);
    expect(alert.textContent).toMatch(/HTTP 500/);
  });

  it("when a later poll fails, the old figures are labelled as the last successful read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (round > 0) throw new TypeError("Failed to fetch");
      return { ok: true, status: 200, json: async () => okBody(String(url)) };
    }));
    render(<RiskCommandCenter />);
    await screen.findByText("Daily risk left");
    expect(screen.queryByTestId("risk-load-error")).toBeNull();
    round = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    const alert = await screen.findByTestId("risk-load-error");
    expect(alert.textContent).toMatch(/could not be refreshed/i);
    expect(alert.textContent).toMatch(/last successful read/i);
    expect(screen.getByTestId("risk-status-badge").textContent).toMatch(/OK.*as of/);
  });

  it("a failed pause is reported, not silently ignored", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "audit");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/risk/pause") && init?.method === "POST") return { ok: false, status: 403, json: async () => ({ error: "forbidden" }) };
      return { ok: true, status: 200, json: async () => okBody(u) };
    }));
    render(<RiskCommandCenter />);
    fireEvent.click(await screen.findByTestId("risk-btn-pause"));
    const alert = await screen.findByTestId("risk-action-error");
    expect(alert.textContent).toMatch(/forbidden/);
    expect(alert.textContent).toMatch(/did not confirm/i);
  });
});
