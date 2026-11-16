import type { StageMetrics, StageValidationResult, StagePromotionCriteria } from "./validation.types";
import { DEFAULT_PROMOTION_CRITERIA, checkAgainstCriteria, toStageResult } from "./promotionCriteria.engine";

// ═══════════════════════════════════════════════════════════════════════════
// SHADOW_MODE validator — candidate runs alongside live system but its
// decisions are recorded only. Adds an explicit invariant: shadow mode
// MUST NOT have placed any orders. Caller signals this via
// `actuallyExecutedTrades` count (typically 0 for shadow).
// ═══════════════════════════════════════════════════════════════════════════

export interface ShadowExtras {
  actuallyExecutedTrades: number;
  // How well shadow predictions agreed with the realised live outcome
  // (independent of the candidate's own win-rate).
  liveAgreementRate01?: number;
}

export function validateShadowMode(
  metrics: StageMetrics,
  extras: ShadowExtras,
  recordedAtIso: string,
  criteria: StagePromotionCriteria = DEFAULT_PROMOTION_CRITERIA.SHADOW_MODE,
): StageValidationResult {
  const blockers: string[] = [];
  if (metrics.stage !== "SHADOW_MODE") {
    return {
      stage: "SHADOW_MODE",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["STAGE_GUARD"],
      metrics, recordedAtIso,
      reasons: [`metrics.stage ${metrics.stage} ≠ SHADOW_MODE`],
      blockers: [`refusing to validate non-SHADOW_MODE metrics here`],
    };
  }
  if (extras.actuallyExecutedTrades > 0) {
    blockers.push(`shadow-mode invariant violated: candidate placed ${extras.actuallyExecutedTrades} live trade(s)`);
  }
  const check = checkAgainstCriteria(metrics, criteria);
  const result = toStageResult(metrics, check, recordedAtIso);
  if (extras.liveAgreementRate01 !== undefined) {
    result.reasons.push(`liveAgreementRate ${extras.liveAgreementRate01.toFixed(2)}`);
    if (extras.liveAgreementRate01 < 0.5) {
      result.failedChecks.push("LIVE_AGREEMENT_RATE");
      result.reasons.push(`LIVE_AGREEMENT_RATE: FAIL — ${extras.liveAgreementRate01.toFixed(2)} < 0.5`);
    }
  }
  if (blockers.length > 0) {
    result.verdict = "FAIL";
    result.blockers.push(...blockers);
  } else if (result.failedChecks.length > 0) {
    result.verdict = "FAIL";
  }
  return result;
}
