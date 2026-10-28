// Truth regressions for My Performance (/my-performance, pages/my-paper-trades).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const { default: MyPerformancePage } = await import("./my-paper-trades");

const view = (label: string, unit: string, effective: number | null, preference: number | null) =>
  ({ label, unit, effective, preference, source: "user_risk_settings", winner: "user", overriddenBy: null, reason: null });

const SETTINGS = {
  id: 1, maxRiskPerTradePercent: 1, maxDailyLossPercent: 3, maxOpenTrades: 3, maxTradesPerDay: 5, maxConsecutiveLosses: 3,
  minRewardRiskRatio: 1.5, cooldownAfterLossMinutes: 15, blockAfterDailyLossHit: true, blockAfterConsecutiveLosses: true,
  requireStopLoss: true, requireTakeProfit: false, requirePlaybook: false, requirePreTradeChecklist: false, requireJournalReason: false,
  allowOverrideInPaperMode: false,
  // The server writes these constants into every risk-settings response; they are not the live switch.
  liveLocked: true, readOnlyMode: true, allowOrderExecution: false,
};

function riskStatus(over: Record<string, unknown> = {}) {
  return {
    settings: SETTINGS,
    effective: {
      maxConsecutiveLosses: view("Losses in a row", "count", 3, 3),
      cooldownAfterLossMinutes: view("Cooldown after a loss", "min", 15, 15),
    },
    today: { pnl: 0, trades: 0, openTrades: 0, consecutiveLosses: 0 },
    week: { pnl: 0 },
    cooldown: { active: false, minutesRemaining: 0 },
    lastBlocked: null,
    activitySource: "paper_trades",
    safetyMode: "paper_only", educationalOnly: true, liveLocked: true, readOnlyMode: true, allowOrderExecution: false,
    ...over,
  };
}

const TRADE = {
  id: 7, symbol: "EURUSD", side: "buy", status: "closed", entryType: "market",
  plannedEntryPrice: 1.08, entryPrice: 1.08, exitPrice: 1.082, stopLoss: 1.078, takeProfit: 1.082, lotSize: 0.1,
  riskAmount: 20, rewardRiskRatio: 1, pnl: 20, pnlPercent: 0.2,
  openedAt: "2026-10-27T09:00:00.000Z", closedAt: "2026-10-27T10:00:00.000Z", cancelledAt: null,
  strategyTag: null, setupGrade: null, reasonForEntry: null, notes: null, createdAt: "2026-10-27T09:00:00.000Z",
};

function okBodies(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/api/me/paper-trades": { trades: [TRADE] },
    "/api/me/trade-journal": { entries: [] },
    "/api/me/performance-calendar": { days: [] },
    "/api/me/performance-summary": { totalTrades: 1, totalPnl: 20, wins: 1, losses: 0, winRate: 100, isEmpty: false },
    "/api/me/ai-trade-reviews": { reviews: [] },
    "/api/me/performance-insights": { topSymbols: [], byStrategy: [], averages: { avgWin: 0, avgLoss: 0, expectancy: 0 }, topMistakes: [], insights: [], bestDay: null, worstDay: null, isEmpty: true, sampleSize: 0 },
    "/api/me/coaching-plan": { traderProfile: "", topStrengths: [], topWeaknesses: [], topMistakes: [], recommendedFocus: "", riskRuleSuggestion: "", journalingPrompt: "", weeklyGoal: "", confidenceNote: "", sampleSize: 0, isEmpty: true },
    "/api/me/playbooks": { playbooks: [] },
    "/api/me/risk/status": riskStatus(),
    "/api/me/risk/events": { events: [], isEmpty: true },
    ...over,
  };
}

/** fetch stub: a Response, a body (200) or a status number (error) per path. */
function stubFetch(bodies: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).split("?")[0]!;
    const b = bodies[path];
    if (b === undefined) return new Response(JSON.stringify({ error: `unmocked ${path}` }), { status: 404 });
    if (typeof b === "number") return new Response(JSON.stringify({ error: `HTTP ${b}` }), { status: b });
    return new Response(JSON.stringify(b), { status: 200 });
  }));
}

// Radix Tabs activate on focus in jsdom; focus + click mirrors a pointer selection.
function selectTab(name: RegExp) {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
  fireEvent.click(trigger);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("My Performance: Risk Governor copy says what the rules do", () => {
  it("does not claim live execution is locked or that the rules only guard demo decisions", async () => {
    stubFetch(okBodies());
    render(<MyPerformancePage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    selectTab(/Risk Governor/);
    await waitFor(() => expect(screen.getByText("Recent risk events")).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/permanently locked/i);
    expect(text).not.toMatch(/Live execution is locked/i);
    expect(text).not.toMatch(/Read-only MT5 bridge/i);
    expect(text).not.toMatch(/demo_only|no broker writes/i);
    expect(text).not.toMatch(/demo-only safety net/i);
    expect(text).not.toMatch(/enforced server-side and cannot be changed/i);
    // What the rules really do: the Risk Governor applies them to every order, live included.
    expect(screen.getByTestId("risk-governor-scope").textContent).toMatch(/every order/i);
    expect(screen.getByTestId("risk-governor-scope").textContent).toMatch(/live/i);
    // The today figures come from the demo trades on this page only.
    expect(screen.getByTestId("risk-governor-scope").textContent).toMatch(/demo trades on this page/i);
  });
});

describe("My Performance: one failed endpoint is not an empty account", () => {
  it("shows the trades when an unrelated endpoint fails, and says which section could not be loaded", async () => {
    stubFetch(okBodies({ "/api/me/coaching-plan": 500 }));
    render(<MyPerformancePage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    expect(screen.queryByText("No demo trades yet")).toBeNull();
    selectTab(/Coaching/);
    await waitFor(() => expect(screen.getByTestId("load-error-coaching").textContent).toMatch(/could not be loaded \(HTTP 500\)/));
    expect(screen.queryByText(/Your coaching plan will improve/)).toBeNull();
  });

  it("a failed trades read says so instead of 'No demo trades yet'", async () => {
    stubFetch(okBodies({ "/api/me/paper-trades": 500 }));
    render(<MyPerformancePage />);
    await waitFor(() => expect(screen.getByTestId("load-error-trades").textContent).toMatch(/could not be loaded \(HTTP 500\)/));
    expect(screen.queryByText("No demo trades yet")).toBeNull();
    expect(screen.queryByText("Create your first demo trade")).toBeNull();
    expect(screen.getByRole("tab", { name: /^Trades/ }).textContent).not.toMatch(/\(0\)/);
  });

  it("failed journal, calendar, insights and playbook reads are not shown as empty", async () => {
    stubFetch(okBodies({
      "/api/me/trade-journal": 500, "/api/me/performance-calendar": 500, "/api/me/performance-summary": 500,
      "/api/me/performance-insights": 500, "/api/me/playbooks": 500,
    }));
    render(<MyPerformancePage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    selectTab(/Journal/);
    await waitFor(() => expect(screen.getByTestId("load-error-journal")).toBeTruthy());
    expect(screen.queryByText("No journal entries yet")).toBeNull();
    selectTab(/Performance/);
    await waitFor(() => expect(screen.getByTestId("load-error-calendar")).toBeTruthy());
    expect(screen.getByTestId("load-error-summary")).toBeTruthy();
    expect(screen.queryByText(/No fake data/)).toBeNull();
    selectTab(/Insights/);
    await waitFor(() => expect(screen.getByTestId("load-error-insights")).toBeTruthy());
    expect(screen.queryByText("No AI insights yet")).toBeNull();
    selectTab(/Playbooks/);
    await waitFor(() => expect(screen.getByTestId("load-error-playbooks")).toBeTruthy());
    expect(screen.queryByText("No playbooks yet")).toBeNull();
  });

  it("failed risk status and risk events reads are not a quiet governor", async () => {
    stubFetch(okBodies({ "/api/me/risk/status": 500, "/api/me/risk/events": 500 }));
    render(<MyPerformancePage />);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    selectTab(/Risk Governor/);
    await waitFor(() => expect(screen.getByTestId("load-error-riskEvents")).toBeTruthy());
    expect(screen.getByTestId("load-error-riskStatus").textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText(/your governor is quiet/)).toBeNull();
  });
});
