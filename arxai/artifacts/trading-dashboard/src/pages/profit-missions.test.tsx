// Profit Mission Phase 1 — render proof for the two-step planner page.
//
// Mounts the real page with the data hooks mocked (no QueryClientProvider, per
// the project's render-proof convention) and drives the two-step flow: fill the
// form → click "Assess mission" → assert the honest read renders (feed-not-
// confirmed banner, required-pace metrics, risk-profile mismatch, the
// Unreasonable tier with feasibility 0 / risk 100, the planning-projection
// note), that the primary action is a DRAFT-only label, and that the create
// mutation is NOT called on the first (assess) click. Also asserts no banned
// promise vocabulary leaks into the rendered DOM.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { MISSION_BANNED_PHRASES } from "@workspace/domain/profit-mission";

// A representative server-shaped mission so the list renders something.
const mission = {
  id: 1,
  status: "draft",
  startingAmount: 1000,
  targetAmount: 1300,
  riskProfile: "balanced",
  math: {
    startingAmount: 1000,
    targetAmount: 1300,
    currentValue: 1000,
    requiredProfit: 300,
    requiredReturnPct: 30,
    remainingProfit: 300,
    totalDays: 7,
    tradingDays: 5,
    elapsedDays: 0,
    remainingDays: 7,
    requiredDailyProfit: 42.86,
    requiredSessionProfit: 60,
    requiredHourlyProfit: 7.5,
    requiredDailyReturnPct: 3.82,
    progressPct: 0,
    progressPctClamped: 0,
    timeElapsedPct: 0,
    currentDailyProfit: 0,
    paceRatio: 0,
    onTrack: false,
    invalid: false,
    invalidReasons: [],
  },
  feasibility: {
    tier: "Aggressive",
    feasibilityScore: 34,
    riskScore: 66,
    recommendedRiskProfile: "aggressive",
    missionType: "high_risk_sprint",
    warnings: ["This is a high-risk target; possible loss is elevated."],
    explanation: "This target needs about a 30.0% total return over 7 day(s).",
    canStart: false,
    startBlockReason: "FEED_NOT_CONFIRMED",
    requiredReturnPct: 30,
    requiredDailyReturnPct: 3.82,
    riskProfileMismatch: { mismatch: false, selected: "balanced", required: "balanced", explanation: null },
  },
  probability: {
    targetHitProbability: 29,
    drawdownRisk: 47,
    failureProbability: 71,
    projections: {
      best: { endingValue: 1300, profit: 300, returnPct: 30 },
      expected: { endingValue: 1087, profit: 87, returnPct: 8.7 },
      worst: { endingValue: 800, profit: -200, returnPct: -20 },
    },
    confidence: "low",
    sampleSize: 0,
    sampleSizeWarnings: ["No historical sample yet — planning projection only."],
    isEstimate: true,
    planningProjectionOnly: true,
    planningProjectionNote:
      "No historical sample is available yet. These values are mathematical planning projections based on your inputs, not backtested probabilities.",
    disclaimer: "All values are projections based on the inputs and pace, not a promise of profit. Actual results vary and possible loss is real.",
  },
};

// Capture the create mutation so we can assert it is NOT fired on assess.
const createMutate = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", () => ({
  useListProfitMissions: () => ({ data: [mission], isLoading: false }),
  useCreateProfitMission: () => ({ mutate: createMutate, isPending: false }),
  usePauseProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  getListProfitMissionsQueryKey: () => ["profit-missions"],
  useParseProfitMissionIntent: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import ProfitMissionsPage from "./profit-missions";

function fillForm(start: string, target: string, days: string) {
  fireEvent.change(screen.getByTestId("input-starting-amount"), { target: { value: start } });
  fireEvent.change(screen.getByTestId("input-target-amount"), { target: { value: target } });
  fireEvent.change(screen.getByTestId("input-timeframe-amount"), { target: { value: days } });
}

afterEach(() => {
  cleanup();
  createMutate.mockReset();
});

describe("Profit Mission planner (Phase 1 two-step)", () => {
  it("starts on the Assess step with no read panels rendered", () => {
    render(<ProfitMissionsPage />);
    expect(screen.getByTestId("button-create-mission").textContent).toMatch(/assess mission/i);
    expect(screen.queryByTestId("section-assessment")).toBeNull();
    expect(screen.queryByTestId("card-feasibility")).toBeNull();
  });

  it("$50 → $100 in 1 day assesses as Unreasonable (feasibility 0 / risk 100), draft-only", () => {
    render(<ProfitMissionsPage />);
    fillForm("50", "100", "1");
    fireEvent.click(screen.getByTestId("button-create-mission"));

    // The honest read appears with both planning banners.
    expect(screen.getByTestId("section-assessment")).toBeTruthy();
    expect(screen.getByTestId("alert-feed-not-confirmed")).toBeTruthy();
    expect(screen.getByTestId("alert-estimate-disclaimer")).toBeTruthy();

    // Feasibility: Unreasonable, 0 / 100, with required-pace metrics surfaced.
    expect(screen.getByTestId("badge-tier").textContent).toMatch(/unreasonable/i);
    expect(screen.getByTestId("metric-feasibility-score").textContent).toMatch(/0\/100/);
    expect(screen.getByTestId("metric-risk-score").textContent).toMatch(/100\/100/);
    expect(screen.getByTestId("metric-required-return").textContent).toMatch(/100%/);
    expect(screen.getByTestId("metric-required-daily-pace").textContent).toMatch(/100% per day/);

    // Risk-profile mismatch (balanced selected, extreme required) is surfaced.
    expect(screen.getByTestId("alert-risk-mismatch").textContent).toMatch(/extreme risk assumptions/i);

    // Probability is framed as a planning projection (sample size 0).
    expect(screen.getByTestId("alert-planning-projection").textContent).toMatch(
      /planning projections based on your inputs, not backtested/i,
    );
    expect(screen.getByTestId("text-probability-caption").textContent).toMatch(/not backtested/i);

    // With no historical sample, scenario labels must read as planning
    // projections — never the vague "(est.)" historical-estimate wording.
    const probabilityCard = screen.getByTestId("card-probability");
    expect(probabilityCard.textContent).not.toMatch(/\(est\.\)/);
    expect(probabilityCard.textContent).toMatch(/best \(planning projection\)/i);
    expect(probabilityCard.textContent).toMatch(/expected \(planning projection\)/i);
    expect(probabilityCard.textContent).toMatch(/worst \(planning projection\)/i);

    // The primary action is a labelled draft — never an execution affordance.
    expect(screen.getByTestId("button-create-mission").textContent).toMatch(/save unrealistic draft/i);

    // Assess never persists: the create mutation must not have fired.
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("$1000 → $1300 in 7 days assesses as Save draft only (feed not confirmed)", () => {
    render(<ProfitMissionsPage />);
    fillForm("1000", "1300", "7");
    fireEvent.click(screen.getByTestId("button-create-mission"));

    expect(screen.getByTestId("badge-tier").textContent).toMatch(/aggressive/i);
    expect(screen.getByTestId("metric-required-daily-pace").textContent).toMatch(/per day/i);
    // Realistic but feed-blocked ⇒ draft-only label, not "start".
    const label = screen.getByTestId("button-create-mission").textContent ?? "";
    expect(label).toMatch(/save draft only/i);
    expect(label).not.toMatch(/start/i);
    expect(createMutate).not.toHaveBeenCalled();
  });

  it("editing an input after assessing resets the read (no stale panels)", () => {
    render(<ProfitMissionsPage />);
    fillForm("1000", "1300", "7");
    fireEvent.click(screen.getByTestId("button-create-mission"));
    expect(screen.getByTestId("section-assessment")).toBeTruthy();
    // Change an input → assessment invalidated, back to the Assess step.
    fireEvent.change(screen.getByTestId("input-target-amount"), { target: { value: "1400" } });
    expect(screen.queryByTestId("section-assessment")).toBeNull();
    expect(screen.getByTestId("button-create-mission").textContent).toMatch(/assess mission/i);
  });

  it("the second click persists the draft via the create mutation", () => {
    render(<ProfitMissionsPage />);
    fillForm("1000", "1300", "7");
    const btn = screen.getByTestId("button-create-mission");
    fireEvent.click(btn); // assess
    expect(createMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-create-mission")); // save
    expect(createMutate).toHaveBeenCalledTimes(1);
  });

  it("never leaks banned promise vocabulary into the rendered DOM (after assess)", () => {
    const { container } = render(<ProfitMissionsPage />);
    fillForm("50", "100", "1");
    fireEvent.click(screen.getByTestId("button-create-mission"));
    const text = (container.textContent ?? "").toLowerCase();
    for (const phrase of MISSION_BANNED_PHRASES) {
      expect(text.includes(phrase), `banned phrase leaked: ${phrase}`).toBe(false);
    }
  });

  it("renders the Battle Room shell as planning/display-only", () => {
    const { container } = render(<ProfitMissionsPage />);
    expect(screen.getByTestId("card-battle-room")).toBeTruthy();
    expect(screen.getByTestId("badge-battle-status")).toBeTruthy();
    expect((container.textContent ?? "").toLowerCase()).toContain("display only");
    // The probability card only exists once a mission is assessed.
    const room = screen.getByTestId("card-battle-room");
    expect(within(room)).toBeTruthy();
  });
});
