import type { StageMetrics, StageValidationResult, StagePromotionCriteria } from "./validation.types";
import { DEFAULT_PROMOTION_CRITERIA, checkAgainstCriteria, toStageResult } from "./promotionCriteria.engine";

// ═══════════════════════════════════════════════════════════════════════════
// WALK_FORWARD validator — adds extra stability check on per-fold
// expectancies (criteria.minFoldsPositive enforced via promotionCriteria).
// Refuses to PASS if foldExpectancyRs is missing or empty.
// ═══════════════════════════════════════════════════════════════════════════

export function validateWalkForward(
  metrics: StageMetrics,
  recordedAtIso: string,
  criteria: StagePromotionCriteria = DEFAULT_PROMOTION_CRITERIA.WALK_FORWARD,
): StageValidationResult {
  const blockers: string[] = [];
  if (metrics.stage !== "WALK_FORWARD") {
    return {
      stage: "WALK_FORWARD",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["STAGE_GUARD"],
      metrics, recordedAtIso,
      reasons: [`metrics.stage ${metrics.stage} ≠ WALK_FORWARD`],
      blockers: [`refusing to validate non-WALK_FORWARD metrics here`],
    };
  }
  if (!metrics.foldExpectancyRs || metrics.foldExpectancyRs.length === 0) {
    blockers.push(`no fold expectancies supplied — walk-forward requires per-fold data`);
    return {
      stage: "WALK_FORWARD",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["WALK_FORWARD_FOLDS"],
      metrics, recordedAtIso,
      reasons: [`missing foldExpectancyRs`],
      blockers,
    };
  }
  const result = toStageResult(metrics, checkAgainstCriteria(metrics, criteria), recordedAtIso);
  result.blockers.push(...blockers);
  return result;
}
