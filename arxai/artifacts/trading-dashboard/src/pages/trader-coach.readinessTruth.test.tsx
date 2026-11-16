import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * Trader Coach header readiness truth. When the server reports that the Risk
 * Governor was not evaluated, the header must not show "Readiness 0/F
 * (NOT_READY)" next to a summary that says "Readiness unavailable." — it says
 * readiness is unavailable. An older server that still sends the 0/F/NOT_READY
 * fallbacks with governorStatus UNKNOWN is downgraded the same way.
 */

import TraderCoachPage from "./trader-coach";

function coach(traderStatus: Record<string, unknown>, summary: string) {
  return {
    coach_report_id: "coach_qa", generated_at: "2026-10-28T09:00:00.000Z", liveTradingStatus: "DISABLED", reportType: "DAILY",
    traderStatus, performanceSummary: {}, topStrengths: [], topWeaknesses: [], repeatedMistakes: [], activeRiskFlags: [],
    currentFocusAreas: [], nextBestActions: [], preSessionChecklist: [], postSessionReviewQuestions: [], warnings: [],
    coachingSummary: summary,
  };
}

function stubFetch(c: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/trader-coach/status") ? { coach: c }
      : url.includes("/playbook") ? { playbook: [] }
      : { weekly: null };
    return { ok: true, json: async () => body } as Response;
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Trader Coach readiness header", () => {
  it("governor not evaluated: header says readiness unavailable, not 0/F (NOT_READY)", async () => {
    stubFetch(coach({
      readinessEvaluated: false, readinessUnavailableReason: "Readiness could not be evaluated: the Risk Governor did not respond for this report.",
      readinessScore: null, readinessGrade: null, readinessLevel: null, governorStatus: "UNKNOWN",
      paperTradingAllowed: null, autopilotAllowed: null, liveTradingAllowed: false,
    }, "Coach report (DAILY) — Risk Governor status: UNKNOWN. Readiness unavailable."));
    render(<TraderCoachPage />);
    const badge = await screen.findByTestId("coach-readiness");
    expect(badge.textContent).toMatch(/Readiness unavailable/);
    expect(badge.textContent).not.toMatch(/0\/F|NOT_READY/);
  });

  it("older server fallbacks (0/F/NOT_READY with governor UNKNOWN) are downgraded to unavailable", async () => {
    stubFetch(coach({
      readinessScore: 0, readinessGrade: "F", readinessLevel: "NOT_READY", governorStatus: "UNKNOWN",
      paperTradingAllowed: false, autopilotAllowed: false, liveTradingAllowed: false,
    }, "Readiness unavailable."));
    render(<TraderCoachPage />);
    const badge = await screen.findByTestId("coach-readiness");
    expect(badge.textContent).toMatch(/Readiness unavailable/);
  });

  it("governor evaluated: header shows the governor's readiness", async () => {
    stubFetch(coach({
      readinessEvaluated: true, readinessUnavailableReason: null,
      readinessScore: 64, readinessGrade: "C", readinessLevel: "DEVELOPING", governorStatus: "PAPER_CAUTION",
      paperTradingAllowed: true, autopilotAllowed: false, liveTradingAllowed: false,
    }, "Readiness 64/C (DEVELOPING)."));
    render(<TraderCoachPage />);
    const badge = await screen.findByTestId("coach-readiness");
    expect(badge.textContent?.replace(/\s+/g, " ").trim()).toBe("Readiness 64/C (DEVELOPING)");
  });
});
