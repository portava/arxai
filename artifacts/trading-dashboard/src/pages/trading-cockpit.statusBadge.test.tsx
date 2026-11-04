// Trading Cockpit status badges: PAPER_CAUTION (Risk Governor) and
// PASS_WITH_WARNINGS (readiness gate) are warning states that carry soft
// warnings. They must not wear the same green as PASS / PAPER_ALLOWED.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/aaci/AaciSyncChip", () => ({ AaciSyncChip: () => null }));
vi.mock("@/components/help/HelpDrawer", () => ({ HelpDrawer: () => null }));
vi.mock("@/components/help/WhyBlockedDrawer", () => ({ WhyBlockedDrawer: () => null }));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", () => {}], bareSymbol: (s: string) => s }));

const { default: TradingCockpit } = await import("./trading-cockpit");

function summary(readinessStatus: string, governorStatus: string, overallHealth: string) {
  return {
    cockpit_id: "ck1", generated_at: "2026-10-28T11:00:00.000Z", mode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED", canPlaceLiveTrade: false, canProceedToLiveTrading: false,
    readiness: { status: readinessStatus, score: 80, grade: "B", paperTestingAllowed: true },
    riskGovernor: { overallStatus: governorStatus, paperTradingAllowed: true, autopilotAllowed: false, hardBlocks: [], softWarnings: [{ code: "W1", message: "Two losses in a row." }] },
    security: { rolesSeeded: true, forbiddenLocked: true, secretsRedacted: "yes" },
    activeSession: null,
    todayPerformance: { totalTrades: 0, wins: 0, losses: 0, breakEven: 0, netPnl: 0, winRate: 0, dayRating: "—" },
    openPaperTrades: [],
    coachSummary: { dailyFocus: "", mistakeToAvoid: [], setupsToWatch: [], setupsToAvoid: [], nextBestActions: [] },
    notifications: { unreadAll: 0, criticalUnread: 0, criticalSamples: [] },
    autopilot: { mode: "OFF", liveTradingAllowed: false, allowedBySession: false, allowedByGovernor: false, sessionStatus: "NONE", cooldowns: [], note: "" },
    systemHealth: { overallHealth, readinessScore: 80, readinessGrade: "B", lastReadinessAt: null, riskGovernorStatus: governorStatus, majorWarnings: [] },
    nextBestAction: { code: "START", label: "Start a paper session.", cta: "Start", severity: "INFO" },
    warnings: [],
  };
}

function serve(s: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    const body = url.includes("/api/trading-cockpit/summary") ? { summary: s }
      : { status: { status: "DONE", currentStep: null, completedSteps: [], skippedSteps: [], totalSteps: 0, nextStep: null, walkthroughCompleted: true } };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TradingCockpit /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Trading Cockpit StatusBadge tones", () => {
  it("caution states are not coloured like PASS", async () => {
    serve(summary("PASS_WITH_WARNINGS", "PAPER_CAUTION", "PASS"));
    renderPage();
    const caution = await screen.findAllByText("PAPER_CAUTION");
    expect(caution.length).toBe(2); // header + health panel
    for (const el of caution) {
      expect(el.className).not.toMatch(/green/);
      expect(el.className).toMatch(/amber/);
    }
    const warn = screen.getByText("PASS_WITH_WARNINGS");
    expect(warn.className).not.toMatch(/green/);
    expect(warn.className).toMatch(/amber/);
    // A clean PASS stays green.
    expect(screen.getByText("PASS").className).toMatch(/green/);
  });

  it("clean states stay green", async () => {
    serve(summary("PASS", "PAPER_ALLOWED", "OK"));
    renderPage();
    for (const el of await screen.findAllByText("PAPER_ALLOWED")) expect(el.className).toMatch(/green/);
  });
});
