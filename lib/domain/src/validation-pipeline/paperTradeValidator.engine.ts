import type { StageMetrics, StageValidationResult, StagePromotionCriteria } from "./validation.types";
import { DEFAULT_PROMOTION_CRITERIA, checkAgainstCriteria, toStageResult } from "./promotionCriteria.engine";

// ═══════════════════════════════════════════════════════════════════════════
// PAPER_TRADING validator — candidate executes against a simulated broker.
// Same invariant as shadow: zero real orders should have hit the live
// account.
// ═══════════════════════════════════════════════════════════════════════════

export interface PaperExtras {
  realOrdersPlaced: number;                      // must be 0
}

export function validatePaperTrading(
  metrics: StageMetrics,
  extras: PaperExtras,
  recordedAtIso: string,
  criteria: StagePromotionCriteria = DEFAULT_PROMOTION_CRITERIA.PAPER_TRADING,
): StageValidationResult {
  const blockers: string[] = [];
  if (metrics.stage !== "PAPER_TRADING") {
    return {
      stage: "PAPER_TRADING",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["STAGE_GUARD"],
      metrics, recordedAtIso,
      reasons: [`metrics.stage ${metrics.stage} ≠ PAPER_TRADING`],
      blockers: [`refusing to validate non-PAPER_TRADING metrics here`],
    };
  }
  if (extras.realOrdersPlaced > 0) {
    blockers.push(`paper-trade invariant violated: ${extras.realOrdersPlaced} real order(s) placed`);
  }
  const result = toStageResult(metrics, checkAgainstCriteria(metrics, criteria), recordedAtIso);
  if (blockers.length > 0) {
    result.verdict = "FAIL";
    result.blockers.push(...blockers);
  }
  return result;
}
