// Trader Coach pre-session checklist: the coach report carries no evaluated
// result for its "auto" rows (daily loss, cooldown, data quality, governor), so
// the page must not label them "(auto-checked)" as if the system verified them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const { default: TraderCoachPage } = await import("./trader-coach");

// Checklist rows exactly as generateCoachReport emits them
// (api-server/src/lib/traderCoach/coach.ts SAFE_DEFAULT_CHECKLIST).
const CHECKLIST = [
  { id: "governor_ok", label: "Risk Governor status checked and not LOCKED", required: true, auto: true },
  { id: "daily_loss_ok", label: "Daily paper loss limit not yet hit", required: true, auto: true },
  { id: "no_cooldown", label: "No active per-symbol revenge cooldown", required: true, auto: true },
  { id: "data_quality", label: "Market data quality is GOOD (not DEGRADED/FALLBACK)", required: true, auto: true },
  { id: "spread_ok", label: "Spread is acceptable for the chosen symbol", required: true, auto: false },
];

function coachReport(checklist: typeof CHECKLIST) {
  return {
    coach_report_id: "c1", generated_at: "2026-10-28T08:00:00.000Z", liveTradingStatus: "DISABLED", reportType: "STATUS",
    traderStatus: {
      readinessScore: 40, readinessGrade: "D", readinessLevel: "LOW", governorStatus: "PAPER_ALLOWED",
      paperTradingAllowed: true, autopilotAllowed: false, liveTradingAllowed: false,
    },
    performanceSummary: {}, topStrengths: [], topWeaknesses: [], repeatedMistakes: [], activeRiskFlags: [],
    currentFocusAreas: [], nextBestActions: [], preSessionChecklist: checklist,
    postSessionReviewQuestions: [], warnings: [], coachingSummary: "Summary.",
  };
}

let checklist: typeof CHECKLIST;

beforeEach(() => {
  checklist = CHECKLIST;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/trader-coach/status") ? { coach: coachReport(checklist) }
      : url.includes("/trader-coach/playbook") ? { playbook: [] }
      : { weekly: null };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Trader Coach pre-session checklist", () => {
  it("does not claim rows the report never evaluated are auto-checked", async () => {
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    expect(list.textContent).not.toMatch(/auto-checked/i);
    for (const id of ["governor_ok", "daily_loss_ok", "no_cooldown", "data_quality"]) {
      const row = within(list).getByTestId(`checklist-${id}`);
      expect(row.textContent).toMatch(/not checked by this report/i);
      const box = row.querySelector("input[type=checkbox]") as HTMLInputElement;
      expect(box.checked).toBe(false);
    }
  });

  it("the server's LOCKED stop row is shown as a governor finding, not as unchecked", async () => {
    checklist = [
      { id: "system_locked", label: "STOP — Risk Governor is LOCKED. Do NOT proceed.", required: true, auto: true },
      ...CHECKLIST,
    ];
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    const row = within(list).getByTestId("checklist-system_locked");
    expect(row.textContent).toMatch(/Risk Governor reports LOCKED/);
    expect(row.textContent).not.toMatch(/not checked by this report/i);
  });

  it("the LOCKED stop row is a measured finding the user cannot tick off", async () => {
    checklist = [
      { id: "system_locked", label: "STOP — Risk Governor is LOCKED. Do NOT proceed.", required: true, auto: true },
      ...CHECKLIST,
    ];
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    const row = within(list).getByTestId("checklist-system_locked");
    // No checkbox at all: ticking a stop condition would read as clearing it.
    expect(row.querySelector("input")).toBeNull();
    expect(row.getAttribute("role")).toBe("alert");
    // The user-confirmation rows stay tickable.
    const box = within(list).getByTestId("checklist-spread_ok").querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    // The instruction to tick rows does not cover the stop row.
    expect(list.parentElement?.textContent).toMatch(/cannot be ticked/i);
  });
});
