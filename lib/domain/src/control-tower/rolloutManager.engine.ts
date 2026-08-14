import {
  type RolloutMetrics, type SystemMode, ROLLOUT_SEQUENCE,
} from "./systemMode.types";
import { nextRolloutMode, prevRolloutMode } from "./systemMode.engine";

export const RolloutRecommendationSchema = {
  PROMOTE: "PROMOTE",
  HOLD: "HOLD",
  DEMOTE: "DEMOTE",
} as const;
export type RolloutRecommendationKind = "PROMOTE" | "HOLD" | "DEMOTE";

export interface RolloutRecommendation {
  kind: RolloutRecommendationKind;
  fromMode: SystemMode;
  toMode: SystemMode;
  failedGates: string[];
  reasons: string[];
}

// Per-mode promotion criteria — gradually stricter at each rung.
export interface RolloutCriteria {
  minDaysInMode: number;
  minSampleCount: number;
  minExpectancyR: number;
  maxDrawdownPctInMode: number;
  minComplianceRate01: number;
}

export const DEFAULT_ROLLOUT_CRITERIA: Record<SystemMode, RolloutCriteria> = {
  // Modes a strategy can advance INTO — gates check against the source mode's metrics.
  OBSERVE_ONLY:        { minDaysInMode: 0,  minSampleCount: 0,    minExpectancyR: -Infinity, maxDrawdownPctInMode: 100, minComplianceRate01: 0    },
  SUGGEST_ONLY:        { minDaysInMode: 1,  minSampleCount: 0,    minExpectancyR: -Infinity, maxDrawdownPctInMode: 100, minComplianceRate01: 0.95 },
  SHADOW_TRADING:      { minDaysInMode: 2,  minSampleCount: 50,   minExpectancyR: 0,         maxDrawdownPctInMode: 100, minComplianceRate01: 0.95 },
  PAPER_TRADING:       { minDaysInMode: 3,  minSampleCount: 100,  minExpectancyR: 0.10,      maxDrawdownPctInMode: 20,  minComplianceRate01: 0.97 },
  MICRO_LOT_LIVE:      { minDaysInMode: 5,  minSampleCount: 200,  minExpectancyR: 0.15,      maxDrawdownPctInMode: 15,  minComplianceRate01: 0.98 },
  LIMITED_AUTO:        { minDaysInMode: 7,  minSampleCount: 100,  minExpectancyR: 0.20,      maxDrawdownPctInMode: 10,  minComplianceRate01: 0.99 },
  FULL_AUTO_GOVERNED:  { minDaysInMode: 14, minSampleCount: 200,  minExpectancyR: 0.25,      maxDrawdownPctInMode: 8,   minComplianceRate01: 0.99 },
  // LOCKDOWN/RECOVERY transitions are NOT handled by rollout — values irrelevant.
  LOCKDOWN:            { minDaysInMode: 0,  minSampleCount: 0,    minExpectancyR: -Infinity, maxDrawdownPctInMode: 100, minComplianceRate01: 0    },
  RECOVERY_MODE:       { minDaysInMode: 0,  minSampleCount: 0,    minExpectancyR: -Infinity, maxDrawdownPctInMode: 100, minComplianceRate01: 0    },
};

export const ROLLOUT_DEMOTION = {
  drawdownDemotePct: 8,                 // current-mode drawdown ≥ this triggers DEMOTE
  expectancyFloorR: -0.05,
  minDemoteSamples: 30,
  complianceFloorRate01: 0.92,
} as const;

// proposeRolloutAction — given the current rollout mode + metrics, return
// PROMOTE / HOLD / DEMOTE. Only handles modes within ROLLOUT_SEQUENCE;
// LOCKDOWN/RECOVERY callers must not invoke this.
//
// Priority: DEMOTE first (risk preservation), then check promotion gates.
export function proposeRolloutAction(
  currentMode: SystemMode,
  metrics: RolloutMetrics,
  criteriaByMode: Record<SystemMode, RolloutCriteria> = DEFAULT_ROLLOUT_CRITERIA,
): RolloutRecommendation {
  const D = ROLLOUT_DEMOTION;
  const reasons: string[] = [];

  if (currentMode === "LOCKDOWN" || currentMode === "RECOVERY_MODE") {
    return { kind: "HOLD", fromMode: currentMode, toMode: currentMode,
      failedGates: [`MODE_NOT_IN_ROLLOUT_SEQUENCE`],
      reasons: [`${currentMode} is transverse — handled by lockdown/recovery engines, not rollout`] };
  }

  // DEMOTE check
  const demoteFailed: string[] = [];
  if (metrics.maxDrawdownPctInMode >= D.drawdownDemotePct) demoteFailed.push(`DRAWDOWN ${metrics.maxDrawdownPctInMode.toFixed(1)}% ≥ ${D.drawdownDemotePct}%`);
  if (metrics.expectancyRInMode < D.expectancyFloorR && metrics.sampleCountInMode >= D.minDemoteSamples) {
    demoteFailed.push(`EXPECTANCY ${metrics.expectancyRInMode.toFixed(2)}R < ${D.expectancyFloorR}R over ${metrics.sampleCountInMode} samples`);
  }
  if (metrics.complianceRate01 < D.complianceFloorRate01 && metrics.sampleCountInMode >= D.minDemoteSamples) {
    demoteFailed.push(`COMPLIANCE ${(metrics.complianceRate01 * 100).toFixed(1)}% < ${(D.complianceFloorRate01 * 100).toFixed(1)}%`);
  }
  if (demoteFailed.length > 0) {
    const target = prevRolloutMode(currentMode);
    if (target === null) {
      reasons.push(...demoteFailed, `→ HOLD at ${currentMode} — demotion triggered but already at first rollout mode`);
      return { kind: "HOLD", fromMode: currentMode, toMode: currentMode, failedGates: demoteFailed, reasons };
    }
    reasons.push(...demoteFailed, `→ DEMOTE ${currentMode} → ${target}`);
    return { kind: "DEMOTE", fromMode: currentMode, toMode: target, failedGates: demoteFailed, reasons };
  }

  // PROMOTE check
  const target = nextRolloutMode(currentMode);
  if (target === null) {
    reasons.push(`already at ${currentMode} (top of rollout) — HOLD`);
    return { kind: "HOLD", fromMode: currentMode, toMode: currentMode, failedGates: [], reasons };
  }
  const next = criteriaByMode[target];
  const failed: string[] = [];
  if (metrics.daysInCurrentMode      < next.minDaysInMode)        failed.push(`DAYS ${metrics.daysInCurrentMode} < ${next.minDaysInMode}`);
  if (metrics.sampleCountInMode      < next.minSampleCount)       failed.push(`SAMPLES ${metrics.sampleCountInMode} < ${next.minSampleCount}`);
  if (metrics.expectancyRInMode      < next.minExpectancyR)       failed.push(`EXPECTANCY ${metrics.expectancyRInMode.toFixed(2)}R < ${next.minExpectancyR}R`);
  if (metrics.maxDrawdownPctInMode   > next.maxDrawdownPctInMode) failed.push(`DRAWDOWN ${metrics.maxDrawdownPctInMode.toFixed(1)}% > ${next.maxDrawdownPctInMode}%`);
  if (metrics.complianceRate01       < next.minComplianceRate01)  failed.push(`COMPLIANCE ${(metrics.complianceRate01 * 100).toFixed(1)}% < ${(next.minComplianceRate01 * 100).toFixed(1)}%`);

  if (failed.length === 0) {
    reasons.push(`all promotion gates passed → PROMOTE ${currentMode} → ${target}`);
    return { kind: "PROMOTE", fromMode: currentMode, toMode: target, failedGates: [], reasons };
  }
  reasons.push(`${failed.length} promotion gate(s) failed — HOLD at ${currentMode}`, ...failed);
  return { kind: "HOLD", fromMode: currentMode, toMode: currentMode, failedGates: failed, reasons };
}

export function isRolloutMode(mode: SystemMode): boolean { return ROLLOUT_SEQUENCE.includes(mode); }
