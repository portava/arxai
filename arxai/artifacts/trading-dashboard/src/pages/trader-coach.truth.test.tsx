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
      readinessScore: 40, readinessGrade: "D", readinessLevel: "LOW", governorStatus,
      paperTradingAllowed: true, autopilotAllowed: false, liveTradingAllowed: false,
    },
    performanceSummary: {}, topStrengths: [], topWeaknesses: [], repeatedMistakes: [], activeRiskFlags: [],
    currentFocusAreas: [], nextBestActions: [], preSessionChecklist: checklist,
    postSessionReviewQuestions: [], warnings: [], coachingSummary: "Summary.",
  };
}

let checklist: typeof CHECKLIST;
let governorStatus: string;

beforeEach(() => {
  checklist = CHECKLIST;
  governorStatus = "PAPER_ALLOWED";
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
    for (const id of ["daily_loss_ok", "no_cooldown", "data_quality"]) {
      const row = within(list).getByTestId(`checklist-${id}`);
      expect(row.textContent).toMatch(/not checked by this report/i);
      const box = row.querySelector("input[type=checkbox]") as HTMLInputElement;
      expect(box.checked).toBe(false);
    }
    // The governor row is the one this report did read (see the governor_ok
    // tests below): it is still unticked, never shown as confirmed.
    const gov = within(list).getByTestId("checklist-governor_ok").querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(gov.checked).toBe(false);
  });

  it("governor_ok says which governor status this report read, and when — not 'not checked by this report'", async () => {
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    const row = within(list).getByTestId("checklist-governor_ok");
    expect(row.textContent).not.toMatch(/not checked by this report/i);
    expect(row.textContent).toMatch(/Risk Governor read as DEMO_ALLOWED/);
    expect(row.textContent).toMatch(/2026-10-28 08:00 UTC/);
    // Not LOCKED, so the user may still confirm it (unticked by default).
    const box = row.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(false);
  });

  it("governor_ok keeps 'not checked by this report' when the governor could not be read (UNKNOWN)", async () => {
    governorStatus = "UNKNOWN";
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    const row = within(list).getByTestId("checklist-governor_ok");
    expect(row.textContent).toMatch(/not checked by this report/i);
    expect(row.textContent).not.toMatch(/read as/i);
  });

  it("LOCKED report: governor_ok ('not LOCKED') has no checkbox and does not claim the report never checked it", async () => {
    governorStatus = "LOCKED";
    checklist = [
      { id: "system_locked", label: "STOP — Risk Governor is LOCKED. Do NOT proceed.", required: true, auto: true },
      ...CHECKLIST,
    ];
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    const row = within(list).getByTestId("checklist-governor_ok");
    expect(row.querySelector("input")).toBeNull();
    expect(row.textContent).not.toMatch(/not checked by this report/i);
    expect(row.textContent).toMatch(/Risk Governor reports LOCKED: this row cannot be confirmed/);
  });

  it("governorStatus LOCKED without the server's STOP row still leaves governor_ok untickable", async () => {
    governorStatus = "LOCKED";
    render(<TraderCoachPage />);
    const list = await screen.findByTestId("pre-session-checklist");
    const row = within(list).getByTestId("checklist-governor_ok");
    expect(row.querySelector("input")).toBeNull();
    expect(row.textContent).not.toMatch(/not checked by this report/i);
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
