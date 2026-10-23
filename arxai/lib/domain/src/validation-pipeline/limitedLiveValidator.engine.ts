import type { StageMetrics, StageValidationResult, StagePromotionCriteria } from "./validation.types";
import { DEFAULT_PROMOTION_CRITERIA, checkAgainstCriteria, toStageResult } from "./promotionCriteria.engine";

// ═══════════════════════════════════════════════════════════════════════════
// LIMITED_LIVE validator — second live stage. Caps total exposure, per-day
// trade count, and per-day cumulative R risk. All caps are HARD: any breach
// fails the stage and is escalated as a blocker for Risk Governor review.
// ═══════════════════════════════════════════════════════════════════════════

export interface LimitedLiveExtras {
  maxObservedExposureR: number;
  maxAllowedExposureR: number;
  maxObservedDailyTrades: number;
  maxAllowedDailyTrades: number;
  maxObservedDailyRiskR: number;
  maxAllowedDailyRiskR: number;
}

export function validateLimitedLive(
  metrics: StageMetrics,
  extras: LimitedLiveExtras,
  recordedAtIso: string,
  criteria: StagePromotionCriteria = DEFAULT_PROMOTION_CRITERIA.LIMITED_LIVE,
): StageValidationResult {
  const blockers: string[] = [];
  if (metrics.stage !== "LIMITED_LIVE") {
    return {
      stage: "LIMITED_LIVE",
      candidateId: metrics.candidateId,
      verdict: "INCONCLUSIVE",
      failedChecks: ["STAGE_GUARD"],
      metrics, recordedAtIso,
      reasons: [`metrics.stage ${metrics.stage} ≠ LIMITED_LIVE`],
      blockers: [`refusing to validate non-LIMITED_LIVE metrics here`],
    };
  }
  const failedChecks: string[] = [];
  if (extras.maxObservedExposureR > extras.maxAllowedExposureR) {
    failedChecks.push("EXPOSURE_CAP");
    blockers.push(`exposure cap breached: ${extras.maxObservedExposureR}R > ${extras.maxAllowedExposureR}R`);
  }
  if (extras.maxObservedDailyTrades > extras.maxAllowedDailyTrades) {
    failedChecks.push("DAILY_TRADE_CAP");
    blockers.push(`daily trade cap breached: ${extras.maxObservedDailyTrades} > ${extras.maxAllowedDailyTrades}`);
  }
  if (extras.maxObservedDailyRiskR > extras.maxAllowedDailyRiskR) {
    failedChecks.push("DAILY_RISK_CAP");
    blockers.push(`daily risk cap breached: ${extras.maxObservedDailyRiskR}R > ${extras.maxAllowedDailyRiskR}R`);
  }
  const result = toStageResult(metrics, checkAgainstCriteria(metrics, criteria), recordedAtIso);
  if (failedChecks.length > 0) {
    result.verdict = "FAIL";
    result.failedChecks.push(...failedChecks);
    result.blockers.push(...blockers);
  }
  return result;
}
