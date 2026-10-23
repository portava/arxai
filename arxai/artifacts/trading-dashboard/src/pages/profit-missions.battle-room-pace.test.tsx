// Task #704 — render proof for the Mission Battle Room's short-vs-long timeframe
// pace display (and the unit-aware mission-class badge sitting next to the
// feasibility tier chip).
//
// Follows the project render-proof convention: mock the data hooks, no live
// QueryClientProvider. BattleRoomShell renders <MissionControls/> (which uses the
// api-client mutation hooks + useQueryClient), so those are mocked. FeasibilityPanel
// is pure props and needs no hooks. We render the two components DIRECTLY (both are
// exported) so we can drive `timeframeMinutes` and the feasibility tier precisely
// without walking the planner/assessment flow.
//
// Asserts:
//   1. A short (under-24h) mission renders the hourly + daily-equivalent pace
//      metrics and NOT the legacy daily-return row.
//   2. A long (>= 24h) mission renders the legacy daily-return row and NOT the
//      hourly/daily-equivalent metrics.
//   3. The unit-class badge renders adjacent to the feasibility tier badge.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

vi.mock("@workspace/api-client-react", () => ({
  usePauseProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelProfitMission: () => ({ mutate: vi.fn(), isPending: false }),
  getListProfitMissionsQueryKey: () => ["profit-missions"],
  getListProfitMissionEventsQueryKey: (id: number) => ["mission-events", id],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { BattleRoomShell, FeasibilityPanel } from "./profit-missions";

afterEach(() => cleanup());

// A mission math block with both the short-tf (hourly + daily-equivalent) and the
// legacy daily-return fields populated, so only the timeframeMinutes branch decides
// which metrics the Battle Room renders.
function makeMath(timeframeMinutes: number) {
  return {
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
    timeframeMinutes,
    requiredReturnPerHourPct: 1.25,
    requiredDailyEquivalentReturnPct: 30,
    progressPct: 0,
    progressPctClamped: 0,
    timeElapsedPct: 0,
    currentDailyProfit: 0,
    paceRatio: 0,
    onTrack: false,
    invalid: false,
    invalidReasons: [],
  };
}

function makeMission(timeframeMinutes: number) {
  return {
    id: 1,
    status: "running",
    currentMode: "shadow",
    startingAmount: 1000,
    targetAmount: 1300,
    currentValue: 1000,
    riskProfile: "balanced",
    timeframeLabel: timeframeMinutes < 1440 ? "1 hour" : "3 days",
    math: makeMath(timeframeMinutes),
    feasibility: { unitAwareMissionClass: "Hyper-scalp sprint" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("Battle Room pace display (short vs long timeframe)", () => {
  it("renders hourly + daily-equivalent pace for a short (under-24h) mission and NOT the legacy daily-return row", () => {
    render(<BattleRoomShell mission={makeMission(60)} />);
    const card = screen.getByTestId("card-battle-room");
    expect(within(card).getByTestId("metric-hourly-return")).toBeTruthy();
    expect(within(card).getByTestId("metric-daily-equivalent-return")).toBeTruthy();
    expect(within(card).queryByTestId("metric-daily-return")).toBeNull();
  });

  it("renders the legacy daily-return row for a long (>= 24h) mission and NOT the hourly/daily-equivalent metrics", () => {
    render(<BattleRoomShell mission={makeMission(4320)} />);
    const card = screen.getByTestId("card-battle-room");
    expect(within(card).getByTestId("metric-daily-return")).toBeTruthy();
    expect(within(card).queryByTestId("metric-hourly-return")).toBeNull();
    expect(within(card).queryByTestId("metric-daily-equivalent-return")).toBeNull();
  });

  it("treats exactly 1440 minutes (24h) as a long mission — locks the < 1440 threshold boundary", () => {
    render(<BattleRoomShell mission={makeMission(1440)} />);
    const card = screen.getByTestId("card-battle-room");
    expect(within(card).getByTestId("metric-daily-return")).toBeTruthy();
    expect(within(card).queryByTestId("metric-hourly-return")).toBeNull();
    expect(within(card).queryByTestId("metric-daily-equivalent-return")).toBeNull();
  });

  it("renders the unit-class badge adjacent to the feasibility tier badge", () => {
    const f = {
      tier: "Aggressive",
      unitAwareMissionClass: "Hyper-scalp sprint",
      feasibilityScore: 34,
      riskScore: 66,
      requiredReturnPct: 30,
      requiredDailyReturnPct: 3.82,
      recommendedRiskProfile: "aggressive",
      missionType: "high_risk_sprint",
      explanation: "Planning estimate.",
      canStart: false,
      startBlockReason: "NO_FEED",
      warnings: [],
      riskProfileMismatch: { mismatch: false, explanation: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    render(<FeasibilityPanel f={f} math={makeMath(60)} />);
    const tier = screen.getByTestId("badge-tier");
    const unitClass = screen.getByTestId("badge-unit-class");
    expect(tier).toBeTruthy();
    expect(unitClass).toBeTruthy();
    // The two badges are consecutive siblings in the same title row.
    expect(tier.nextElementSibling).toBe(unitClass);
    expect(unitClass.textContent).toMatch(/hyper-scalp sprint/i);
  });
});
