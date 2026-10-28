import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// Trader Coach and Session Report never read /api/me/account-mode. A
// LIVE_SHARED user may be armed for live execution, so these pages must not
// print a literal "LIVE TRADING DISABLED" / "Live trading remains DISABLED"
// (Notification Center already dropped the same badge for this reason).

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ isLoading: false, isLive: true, isDemo: false, liveExecutionArmed: true, cleanModeLabel: "Live" }),
}));

const { default: TraderCoachPage } = await import("./trader-coach");
const { default: SessionReport } = await import("./session-report");

const coach = {
  coach_report_id: "c1", generated_at: new Date().toISOString(), liveTradingStatus: "DISABLED", reportType: "DAILY",
  traderStatus: {
    readinessScore: 60, readinessGrade: "C", readinessLevel: "PAPER_READY", governorStatus: "PAPER_ALLOWED",
    paperTradingAllowed: true, autopilotAllowed: false, liveTradingAllowed: false,
  },
  performanceSummary: {}, topStrengths: [], topWeaknesses: [], repeatedMistakes: [], activeRiskFlags: [],
  currentFocusAreas: [], nextBestActions: [], preSessionChecklist: [], postSessionReviewQuestions: [], warnings: [],
  coachingSummary: "Coach report (DAILY).",
};

function respond(url: string): unknown {
  if (url.includes("/trader-coach/status")) return { coach, liveTradingStatus: "DISABLED" };
  if (url.includes("/trader-coach/playbook")) return { playbook: [] };
  if (url.includes("/trader-coach/weekly")) return { weekly: null };
  if (url.includes("/paper-sessions")) return { sessions: [] };
  return {};
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("coach pages do not assert the account's live status", () => {
  it("Trader Coach header does not say LIVE TRADING DISABLED", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => ({ ok: true, json: async () => respond(String(u)) })));
    render(<TraderCoachPage />);
    await screen.findByText("Trader Coach");
    expect(document.body.textContent).not.toMatch(/live trading (remains )?disabled/i);
    expect(screen.queryByText("DEMO ONLY")).toBeNull();
  });

  it("Session Report header does not say live trading remains DISABLED", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => ({ ok: true, json: async () => respond(String(u)) })));
    render(<SessionReport />);
    await screen.findByText("Session Report");
    expect(document.body.textContent).not.toMatch(/live trading (remains )?disabled/i);
  });
});
