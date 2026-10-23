import type { StageMetrics, StageValidationResult, StagePromotionCriteria } from "./validation.types";
import { DEFAULT_PROMOTION_CRITERIA, checkAgainstCriteria, toStageResult } from "./promotionCriteria.engine";

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST validator — pure check against criteria with stage guard.
// ═══════════════════════════════════════════════════════════════════════════

export function validateBacktest(
  metrics: StageMetrics,
  recordedAtIso: string,
  criteria: StagePromotionCriteria = DEFAULT_PROMOTION_CRITERIA.BACKTEST,
): StageValidationResult {
  if (metrics.stage !== "BACKTEST") {
    return {
      stage: "BACKTEST",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["STAGE_GUARD"],
      metrics, recordedAtIso,
      reasons: [`metrics.stage ${metrics.stage} ≠ BACKTEST`],
      blockers: [`refusing to validate non-BACKTEST metrics here`],
    };
  }
  return toStageResult(metrics, checkAgainstCriteria(metrics, criteria), recordedAtIso);
}
