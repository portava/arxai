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

  // Merged with the UNKNOWN risk status: a loss limit that could not be
  // valued or measured is not "not reached".
  it("an UNKNOWN risk status never says new trades are not blocked by a loss limit", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "rules");
    const reason = "Your 2% daily loss cap cannot be valued because account equity is unknown.";
    stub(cards({ riskStatus: "UNKNOWN", riskStatusReason: reason, dailyRiskRemaining: null,
      permissions: { trading: true, pauseReason: null, stopSwitchEngaged: false, blockedBy: [] } }));
    render(<RiskCommandCenter />);
    const row = await screen.findByTestId("risk-perm-new-trades");
    expect(row.textContent).not.toMatch(/not blocked by a stop switch or loss limit/);
    expect(row.textContent).toMatch(/a loss limit could not be checked/);
    expect(row.textContent).toContain(reason);
  });
});

// The Summary tab's Overtrading stat read NORMAL when the trader's activity
// could not be read; the server now sends UNKNOWN and the page says so.
describe("Risk Command Center — Summary tab overtrading", () => {
  it("UNKNOWN reads 'Not measured', never NORMAL", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "summary");
    stub(cards({ tradesToday: null, consecutiveLosses: null, overtrading: "UNKNOWN" }));
    render(<RiskCommandCenter />);
    expect(await screen.findByText("Not measured — activity could not be read")).toBeTruthy();
    expect(screen.queryByText("NORMAL")).toBeNull();
    expect(screen.queryByText("UNKNOWN")).toBeNull();
  });
});

// With a weekly cap set and the trading activity unreadable, the server read
// weekly use as 0 ("not blocked by ... loss limit", "Weekly used $0", the
// whole cap "left") while the Risk Governor refused every new order. The
// server now sends weekly use as null with weeklyRiskUsedUnmeasured, and
// blockedBy "activity_unread"; the page says what that means.
describe("Risk Command Center — unmeasured loss use", () => {
  const statValue = (label: string) => screen.getByText(label).parentElement?.querySelector("p:last-child")?.textContent ?? "";

  it("activity_unread reads blocked, naming why", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "rules");
    stub(cards({ riskStatus: "UNKNOWN", riskStatusReason: "This week's trading activity could not be read, so weekly risk used is unknown.",
      weeklyRiskRemaining: null, weeklyRiskUsedUnmeasured: true,
      permissions: { trading: false, pauseReason: null, stopSwitchEngaged: false, blockedBy: ["activity_unread"] } }));
    render(<RiskCommandCenter />);
    const row = await screen.findByTestId("risk-perm-new-trades");
    expect(row.textContent).toMatch(/New trades: blocked/);
    expect(row.textContent).toMatch(/trading activity could not be read/);
    expect(row.textContent).not.toMatch(/activity_unread/);
    expect(row.textContent).not.toMatch(/not blocked by/);
  });

  it("an unmeasured weekly use is never 'no cap set' or $0", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "summary");
    stub(cards({ riskStatus: "UNKNOWN", weeklyRiskRemaining: null, weeklyRiskLimitUnvalued: false, weeklyRiskUsedUnmeasured: true,
      permissions: { trading: false, pauseReason: null, stopSwitchEngaged: false, blockedBy: ["activity_unread"] } }));
    render(<RiskCommandCenter />);
    await screen.findByText("Weekly risk left");
    expect(statValue("Weekly risk left")).not.toMatch(/no cap set/);
    expect(statValue("Weekly risk left")).toMatch(/not measured/);
  });

  it("the budget's unmeasured daily / weekly use reads 'not measured', never $null or $0", async () => {
    window.localStorage.setItem("arx.pageTab.risk-command-center", "limits");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.includes("/risk-profile") ? PROFILE
        : url.includes("/risk/budget") ? { ...BUDGET, riskStatus: "UNKNOWN", dailyRiskUsed: null, dailyRiskRemaining: null, weeklyRiskLimit: 300, weeklyRiskUsed: null,
          dailyRiskUsedUnmeasured: true, weeklyRiskUsedUnmeasured: true }
        : cards({});
      return { ok: true, status: 200, json: async () => body };
    }));
    render(<RiskCommandCenter />);
    await screen.findByText("Weekly used");
    expect(statValue("Daily used")).toBe("not measured");
    expect(statValue("Weekly used")).toBe("not measured");
  });
});
