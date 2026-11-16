// Profit Mission planner — pure presentation-helper tests (Vitest).
//
// These lock the two-step assess → save button label, the feed-gated
// `canStartMission` mirror, and the small percentage formatters. They are pure
// and IO-free; nothing here touches an execution gate.

import { describe, it, expect } from "vitest";
import type { FeasibilityVerdict } from "@workspace/domain/profit-mission";
import {
  PLANNER_ACTION_LABELS,
  resolvePrimaryActionLabel,
  canStartMission,
  isUnrealisticMission,
  pctTrim,
  pctTrimPerDay,
} from "./profitMissionPlanner";

function verdict(over: Partial<FeasibilityVerdict>): FeasibilityVerdict {
  return {
    tier: "Aggressive",
    missionType: "high_risk_sprint",
    feasibilityScore: 40,
    riskScore: 70,
    canStart: false,
    startBlockReason: "FEED_NOT_CONFIRMED",
    explanation: "",
    warnings: [],
    requiredReturnPct: 30,
    requiredDailyReturnPct: 3.8,
    recommendedRiskProfile: "aggressive",
    riskProfileMismatch: {
      mismatch: false,
      selected: "aggressive",
      required: "aggressive",
      explanation: null,
    },
    ...over,
  } as FeasibilityVerdict;
}

describe("resolvePrimaryActionLabel", () => {
  it("returns Assess when not assessed yet (regardless of verdict)", () => {
    expect(resolvePrimaryActionLabel(false, null)).toBe(PLANNER_ACTION_LABELS.ASSESS);
    expect(resolvePrimaryActionLabel(false, verdict({}))).toBe(PLANNER_ACTION_LABELS.ASSESS);
  });

  it("returns Assess when assessed but verdict is missing", () => {
    expect(resolvePrimaryActionLabel(true, null)).toBe(PLANNER_ACTION_LABELS.ASSESS);
  });

  it("returns Save unrealistic draft for an unreasonable target", () => {
    const v = verdict({ tier: "Unreasonable", missionType: "unrealistic", canStart: false });
    expect(resolvePrimaryActionLabel(true, v)).toBe(PLANNER_ACTION_LABELS.SAVE_UNREALISTIC_DRAFT);
  });

  it("returns Save draft only when realistic but feed not confirmed", () => {
    const v = verdict({ canStart: false });
    expect(resolvePrimaryActionLabel(true, v)).toBe(PLANNER_ACTION_LABELS.SAVE_DRAFT);
  });

  it("returns Save & start only when the engine itself permits start", () => {
    const v = verdict({ canStart: true, startBlockReason: null });
    expect(resolvePrimaryActionLabel(true, v)).toBe(PLANNER_ACTION_LABELS.SAVE_AND_START);
  });

  it("unreasonable wins over a (hypothetical) startable flag — never offers start", () => {
    const v = verdict({ tier: "Unreasonable", canStart: true, startBlockReason: null });
    expect(resolvePrimaryActionLabel(true, v)).toBe(PLANNER_ACTION_LABELS.SAVE_UNREALISTIC_DRAFT);
  });
});

describe("canStartMission / isUnrealisticMission", () => {
  it("canStartMission mirrors the engine canStart flag, false on null", () => {
    expect(canStartMission(null)).toBe(false);
    expect(canStartMission(verdict({ canStart: false }))).toBe(false);
    expect(canStartMission(verdict({ canStart: true }))).toBe(true);
  });

  it("isUnrealisticMission is true only for the Unreasonable tier", () => {
    expect(isUnrealisticMission(null)).toBe(false);
    expect(isUnrealisticMission(verdict({ tier: "Aggressive" }))).toBe(false);
    expect(isUnrealisticMission(verdict({ tier: "Unreasonable" }))).toBe(true);
  });
});

describe("pctTrim / pctTrimPerDay", () => {
  it("trims trailing zeros and clamps non-finite to 0", () => {
    expect(pctTrim(100)).toBe("100%");
    expect(pctTrim(3.819)).toBe("3.82%");
    expect(pctTrim(30)).toBe("30%");
    expect(pctTrim(Number.NaN)).toBe("0%");
    expect(pctTrim(Number.POSITIVE_INFINITY)).toBe("0%");
  });

  it("appends a per-day suffix", () => {
    expect(pctTrimPerDay(3.819)).toBe("3.82% per day");
    expect(pctTrimPerDay(100)).toBe("100% per day");
  });
});
