// Regression: the Battle Room "Pace status" mapped !math.onTrack to
// "Behind pace" whatever the mission status. computeMissionMath sets
// currentDailyProfit to 0 when no time has elapsed or nothing was realised, so
// draft, pending, paused and just-created missions all read "Behind pace"
// next to a "Draft" badge and "Progress 0%". A mission that has not started,
// or has no recorded profit yet, is not behind pace.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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

function makeMission(timeframeMinutes: number, overrides: Record<string, unknown> = {}, mathOverrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "running",
    currentMode: "shadow",
    startingAmount: 1000,
    targetAmount: 1300,
    currentValue: 1000,
    riskProfile: "balanced",
    timeframeLabel: timeframeMinutes < 1440 ? "1 hour" : "3 days",
    math: { ...makeMath(timeframeMinutes), ...mathOverrides },
    feasibility: { unitAwareMissionClass: "Hyper-scalp sprint" },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function paceText(): string {
  return screen.getByTestId("metric-pace-status").textContent ?? "";
}

describe("Battle Room pace status truth", () => {
  it("a draft mission (cannot start) is not 'Behind pace'", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "draft" }, { elapsedDays: 2 })} />);
    expect(paceText()).not.toMatch(/behind pace/i);
    expect(paceText()).toMatch(/not started/i);
  });

  it("a pending-approval mission is not 'Behind pace'", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "pending_approval" })} />);
    expect(paceText()).toMatch(/not started/i);
  });

  it("a paused mission does not show a pace verdict", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "paused" }, { elapsedDays: 2 })} />);
    expect(paceText()).not.toMatch(/behind pace|on pace/i);
    expect(paceText()).toMatch(/paused/i);
  });

  it("a just-created running mission (no time elapsed) is too early to measure", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "running" }, { elapsedDays: 0 })} />);
    expect(paceText()).not.toMatch(/behind pace/i);
    expect(paceText()).toMatch(/too early/i);
  });

  it("a running mission with no profit recorded yet says so rather than 'Behind pace'", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "running" }, { elapsedDays: 1 })} />);
    expect(paceText()).not.toMatch(/behind pace/i);
    expect(paceText()).toMatch(/no profit recorded yet/i);
  });

  it("a running mission with recorded P/L below the required pace is 'Behind pace'", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "running", currentValue: 1010 }, { elapsedDays: 1, currentValue: 1010, currentDailyProfit: 10 })} />);
    expect(paceText()).toBe("Behind pace");
  });

  it("a running mission at or above the required pace is 'On pace'", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "running", currentValue: 1100 }, { elapsedDays: 1, currentValue: 1100, currentDailyProfit: 100, onTrack: true })} />);
    expect(paceText()).toBe("On pace");
  });

  it("invalid mission math is not given a pace verdict", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "running", currentValue: 1010 }, { elapsedDays: 1, currentValue: 1010, invalid: true })} />);
    expect(paceText()).toMatch(/not measurable/i);
  });

  it("an ended mission does not show a live pace verdict", () => {
    render(<BattleRoomShell mission={makeMission(4320, { status: "expired", currentValue: 1010 }, { elapsedDays: 3, currentValue: 1010 })} />);
    expect(paceText()).not.toMatch(/behind pace|on pace/i);
    expect(paceText()).toMatch(/ended/i);
  });
});
