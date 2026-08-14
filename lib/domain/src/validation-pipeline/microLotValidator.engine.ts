import type { StageMetrics, StageValidationResult, StagePromotionCriteria } from "./validation.types";
import { DEFAULT_PROMOTION_CRITERIA, checkAgainstCriteria, toStageResult } from "./promotionCriteria.engine";

// ═══════════════════════════════════════════════════════════════════════════
// MICRO_LOT_LIVE validator — first live stage. Hard cap on max lot size
// per trade; any breach fails the stage immediately.
// ═══════════════════════════════════════════════════════════════════════════

export interface MicroLotExtras {
  maxObservedLots: number;
  maxAllowedLots: number;                        // e.g. 0.01 for true micro
}

export function validateMicroLot(
  metrics: StageMetrics,
  extras: MicroLotExtras,
  recordedAtIso: string,
  criteria: StagePromotionCriteria = DEFAULT_PROMOTION_CRITERIA.MICRO_LOT_LIVE,
): StageValidationResult {
  const blockers: string[] = [];
  if (metrics.stage !== "MICRO_LOT_LIVE") {
    return {
      stage: "MICRO_LOT_LIVE",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["STAGE_GUARD"],
      metrics, recordedAtIso,
      reasons: [`metrics.stage ${metrics.stage} ≠ MICRO_LOT_LIVE`],
      blockers: [`refusing to validate non-MICRO_LOT_LIVE metrics here`],
    };
  }
  if (extras.maxObservedLots > extras.maxAllowedLots) {
    blockers.push(`micro-lot cap breached: observed ${extras.maxObservedLots} > allowed ${extras.maxAllowedLots}`);
  }
  const result = toStageResult(metrics, checkAgainstCriteria(metrics, criteria), recordedAtIso);
  if (blockers.length > 0) {
    result.verdict = "FAIL";
    result.failedChecks.push("MICRO_LOT_CAP");
    result.blockers.push(...blockers);
  }
  return result;
}
