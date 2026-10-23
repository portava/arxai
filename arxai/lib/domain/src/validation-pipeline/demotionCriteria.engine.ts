import {
  type DemotionCheck, type DemotionTrigger, type StageMetrics,
  type CandidateState, type ValidationStage, previousStage, stageRank,
} from "./validation.types";

// ═══════════════════════════════════════════════════════════════════════════
// Demotion Criteria — pure check that decides whether a candidate must
// step DOWN one stage (or further). Triggers:
//
//   • EDGE_DECAY            — rolling expectancy slope strongly negative
//   • DRAWDOWN_BREACH       — observed maxDrawdownR ≥ breachR
//   • LOSING_STREAK_BREACH  — losing streak ≥ breachStreak
//   • EXECUTION_QUALITY_DROP, RISK_COMPLIANCE_DROP — score below floor
//   • FALSE_APPROVAL_SPIKE / FALSE_BLOCK_SPIKE — above ceiling
//
// Severity rule: DRAWDOWN_BREACH and RISK_COMPLIANCE_DROP send the
// candidate back to SHADOW_MODE (or the previous stage, whichever is
// earlier). All other triggers step back exactly one stage. Never demote
// a RESEARCH candidate.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_DEMOTION_TUNING = {
  edgeDecaySlopeBelow:        -0.05,             // expectancyR / window
  drawdownBreachR:             6,
  losingStreakBreach:          8,
  executionQualityFloor01:     0.55,
  riskComplianceFloor01:       0.85,
  falseApprovalCeiling01:      0.30,
  falseBlockCeiling01:         0.30,
} as const;
export type DemotionTuning = typeof DEFAULT_DEMOTION_TUNING;

export function checkDemotion(
  state: CandidateState,
  metrics: StageMetrics,
  tuning: DemotionTuning = DEFAULT_DEMOTION_TUNING,
): DemotionCheck {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const triggers: DemotionTrigger[] = [];

  if (metrics.candidateId !== state.candidate.candidateId) {
    blockers.push(`metrics.candidateId ${metrics.candidateId} ≠ state.candidate.candidateId ${state.candidate.candidateId}`);
  }
  // NOTE: Frozen candidates ARE eligible for demotion. A freeze blocks
  // *promotion* (Risk Governor veto on advancement); it must not lock a
  // failing strategy in a live stage. A demotion while frozen still moves
  // the candidate to a safer stage; the frozen flag is preserved by the
  // caller, so the Governor's veto on future promotion remains in force.

  if (typeof metrics.rollingExpectancySlope === "number"
      && metrics.rollingExpectancySlope <= tuning.edgeDecaySlopeBelow) {
    triggers.push("EDGE_DECAY");
    reasons.push(`EDGE_DECAY: slope ${metrics.rollingExpectancySlope.toFixed(3)} ≤ ${tuning.edgeDecaySlopeBelow}`);
  }
  if (metrics.maxDrawdownR >= tuning.drawdownBreachR) {
    triggers.push("DRAWDOWN_BREACH");
    reasons.push(`DRAWDOWN_BREACH: ${metrics.maxDrawdownR.toFixed(2)} ≥ ${tuning.drawdownBreachR}`);
  }
  if (metrics.longestLosingStreak >= tuning.losingStreakBreach) {
    triggers.push("LOSING_STREAK_BREACH");
    reasons.push(`LOSING_STREAK_BREACH: ${metrics.longestLosingStreak} ≥ ${tuning.losingStreakBreach}`);
  }
  if (metrics.executionQuality01 < tuning.executionQualityFloor01) {
    triggers.push("EXECUTION_QUALITY_DROP");
    reasons.push(`EXECUTION_QUALITY_DROP: ${metrics.executionQuality01.toFixed(2)} < ${tuning.executionQualityFloor01}`);
  }
  if (metrics.riskCompliance01 < tuning.riskComplianceFloor01) {
    triggers.push("RISK_COMPLIANCE_DROP");
    reasons.push(`RISK_COMPLIANCE_DROP: ${metrics.riskCompliance01.toFixed(2)} < ${tuning.riskComplianceFloor01}`);
  }
  if (metrics.falseApprovalRate01 > tuning.falseApprovalCeiling01) {
    triggers.push("FALSE_APPROVAL_SPIKE");
    reasons.push(`FALSE_APPROVAL_SPIKE: ${metrics.falseApprovalRate01.toFixed(2)} > ${tuning.falseApprovalCeiling01}`);
  }
  if (metrics.falseBlockRate01 > tuning.falseBlockCeiling01) {
    triggers.push("FALSE_BLOCK_SPIKE");
    reasons.push(`FALSE_BLOCK_SPIKE: ${metrics.falseBlockRate01.toFixed(2)} > ${tuning.falseBlockCeiling01}`);
  }

  // Never act on a demotion check that has structural blockers
  // (e.g. candidateId mismatch) — blockers must be resolved first.
  // Frozen candidates ARE demotable (see note above on freeze semantics).
  const shouldDemote = triggers.length > 0
    && state.currentStage !== "RESEARCH"
    && blockers.length === 0;

  // Pick proposed stage:
  //   • DRAWDOWN_BREACH or RISK_COMPLIANCE_DROP → at least SHADOW_MODE.
  //   • Else → step back exactly one stage.
  // Hard invariant: proposedStage rank MUST be strictly less than
  // currentStage rank. If logic ever produced a rank ≥ current, that would
  // be a silent promotion-via-demotion. Clamp to oneBack as a safety net.
  let proposedStage: ValidationStage = state.currentStage;
  if (shouldDemote) {
    const severe = triggers.includes("DRAWDOWN_BREACH")
                || triggers.includes("RISK_COMPLIANCE_DROP");
    const oneBack = previousStage(state.currentStage) ?? "RESEARCH";
    const shadowOrEarlier: ValidationStage =
      stageRank("SHADOW_MODE") < stageRank(state.currentStage) ? "SHADOW_MODE" : oneBack;
    proposedStage = severe ? shadowOrEarlier : oneBack;
    // Safety clamp: never accidentally produce a stage at or above current.
    if (stageRank(proposedStage) >= stageRank(state.currentStage)) {
      reasons.push(`SAFETY_CLAMP: computed proposedStage ${proposedStage} ≥ currentStage ${state.currentStage}; falling back to ${oneBack}`);
      proposedStage = oneBack;
    }
  }

  return {
    candidateId: state.candidate.candidateId,
    shouldDemote, triggers, proposedStage,
    reasons, blockers,
  };
}
