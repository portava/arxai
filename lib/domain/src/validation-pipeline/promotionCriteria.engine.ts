import {
  type ValidationStage, type StageMetrics, type StagePromotionCriteria,
  type StageValidationResult, type CandidateId,
} from "./validation.types";

// ═══════════════════════════════════════════════════════════════════════════
// Promotion Criteria — DEFAULT_CRITERIA defines the per-stage threshold
// table. checkAgainstCriteria() runs every check and returns a structured
// list of failed-check ids plus reasons. Pure.
//
// Each successive stage tightens the bar: more samples, higher calibration,
// lower acceptable false-rates, stricter risk compliance.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_PROMOTION_CRITERIA: Record<ValidationStage, StagePromotionCriteria> = {
  RESEARCH: stricter("RESEARCH", {
    minTrades: 0, minExpectancyR: -Infinity, maxDrawdownR: Infinity,
    maxLosingStreak: 9999,
    minConfidenceCalibration01: 0, minExecutionQuality01: 0, minRiskCompliance01: 0,
    maxFalseApprovalRate01: 1, maxFalseBlockRate01: 1,
  }),
  BACKTEST: stricter("BACKTEST", {
    minTrades: 100, minExpectancyR: 0.10, maxDrawdownR: 8,
    maxLosingStreak: 8,
    minConfidenceCalibration01: 0.55, minExecutionQuality01: 0.50,
    minRiskCompliance01: 0.80,
    maxFalseApprovalRate01: 0.25, maxFalseBlockRate01: 0.25,
  }),
  OUT_OF_SAMPLE_TEST: stricter("OUT_OF_SAMPLE_TEST", {
    minTrades: 60, minExpectancyR: 0.07, maxDrawdownR: 8,
    maxLosingStreak: 8,
    minConfidenceCalibration01: 0.55, minExecutionQuality01: 0.50,
    minRiskCompliance01: 0.82,
    maxFalseApprovalRate01: 0.22, maxFalseBlockRate01: 0.22,
  }),
  WALK_FORWARD: stricter("WALK_FORWARD", {
    minTrades: 200, minExpectancyR: 0.10, maxDrawdownR: 8,
    maxLosingStreak: 8,
    minConfidenceCalibration01: 0.60, minExecutionQuality01: 0.55,
    minRiskCompliance01: 0.85,
    maxFalseApprovalRate01: 0.20, maxFalseBlockRate01: 0.20,
    minFoldsPositive: 3,
  }),
  MONTE_CARLO_STRESS_TEST: stricter("MONTE_CARLO_STRESS_TEST", {
    minTrades: 100, minExpectancyR: 0.08, maxDrawdownR: 7,
    maxLosingStreak: 8,
    minConfidenceCalibration01: 0.60, minExecutionQuality01: 0.55,
    minRiskCompliance01: 0.85,
    maxFalseApprovalRate01: 0.20, maxFalseBlockRate01: 0.20,
  }),
  REGIME_SPECIFIC_TEST: stricter("REGIME_SPECIFIC_TEST", {
    minTrades: 120, minExpectancyR: 0.08, maxDrawdownR: 7,
    maxLosingStreak: 7,
    minConfidenceCalibration01: 0.62, minExecutionQuality01: 0.58,
    minRiskCompliance01: 0.87,
    maxFalseApprovalRate01: 0.20, maxFalseBlockRate01: 0.20,
  }),
  EXECUTION_REALITY_TEST: stricter("EXECUTION_REALITY_TEST", {
    minTrades: 100, minExpectancyR: 0.08, maxDrawdownR: 6,
    maxLosingStreak: 7,
    minConfidenceCalibration01: 0.63, minExecutionQuality01: 0.60,
    minRiskCompliance01: 0.88,
    maxFalseApprovalRate01: 0.18, maxFalseBlockRate01: 0.18,
  }),
  SHADOW_MODE: stricter("SHADOW_MODE", {
    minTrades: 100, minExpectancyR: 0.08, maxDrawdownR: 6,
    maxLosingStreak: 7,
    minConfidenceCalibration01: 0.65, minExecutionQuality01: 0.60,
    minRiskCompliance01: 0.90,
    maxFalseApprovalRate01: 0.18, maxFalseBlockRate01: 0.18,
  }),
  PAPER_TRADING: stricter("PAPER_TRADING", {
    minTrades: 80, minExpectancyR: 0.10, maxDrawdownR: 5,
    maxLosingStreak: 6,
    minConfidenceCalibration01: 0.68, minExecutionQuality01: 0.65,
    minRiskCompliance01: 0.92,
    maxFalseApprovalRate01: 0.15, maxFalseBlockRate01: 0.15,
  }),
  MICRO_LOT_LIVE: stricter("MICRO_LOT_LIVE", {
    minTrades: 60, minExpectancyR: 0.12, maxDrawdownR: 4,
    maxLosingStreak: 5,
    minConfidenceCalibration01: 0.70, minExecutionQuality01: 0.70,
    minRiskCompliance01: 0.95,
    maxFalseApprovalRate01: 0.12, maxFalseBlockRate01: 0.12,
  }),
  LIMITED_LIVE: stricter("LIMITED_LIVE", {
    minTrades: 100, minExpectancyR: 0.15, maxDrawdownR: 4,
    maxLosingStreak: 5,
    minConfidenceCalibration01: 0.75, minExecutionQuality01: 0.75,
    minRiskCompliance01: 0.97,
    maxFalseApprovalRate01: 0.10, maxFalseBlockRate01: 0.10,
  }),
  FULL_GOVERNED_LIVE: stricter("FULL_GOVERNED_LIVE", {
    minTrades: 200, minExpectancyR: 0.15, maxDrawdownR: 3,
    maxLosingStreak: 4,
    minConfidenceCalibration01: 0.80, minExecutionQuality01: 0.80,
    minRiskCompliance01: 0.98,
    maxFalseApprovalRate01: 0.08, maxFalseBlockRate01: 0.08,
  }),
};

function stricter(stage: ValidationStage,
  c: Omit<StagePromotionCriteria, "stage">): StagePromotionCriteria {
  return { stage, ...c };
}

export interface CriteriaCheckResult {
  candidateId: CandidateId;
  stage: ValidationStage;
  passed: boolean;
  failedChecks: string[];
  reasons: string[];
}

export function checkAgainstCriteria(
  metrics: StageMetrics,
  criteria: StagePromotionCriteria,
): CriteriaCheckResult {
  const reasons: string[] = [];
  const failedChecks: string[] = [];
  // Hard guard: a caller cannot weaken a stage's bar by passing a different
  // stage's criteria. Mismatch is a definitive FAIL, not just a reason.
  if (metrics.stage !== criteria.stage) {
    failedChecks.push("CRITERIA_STAGE_MISMATCH");
    reasons.push(`CRITERIA_STAGE_MISMATCH: FAIL — metrics ${metrics.stage} vs criteria ${criteria.stage}`);
  }

  fail(metrics.trades >= criteria.minTrades,
    "MIN_SAMPLE_SIZE", `trades ${metrics.trades} < min ${criteria.minTrades}`);
  fail(metrics.expectancyR >= criteria.minExpectancyR,
    "POSITIVE_EXPECTANCY",
    `expectancyR ${metrics.expectancyR.toFixed(3)} < min ${criteria.minExpectancyR}`);
  fail(metrics.maxDrawdownR <= criteria.maxDrawdownR,
    "MAX_DRAWDOWN",
    `maxDrawdownR ${metrics.maxDrawdownR.toFixed(2)} > max ${criteria.maxDrawdownR}`);
  fail(metrics.longestLosingStreak <= criteria.maxLosingStreak,
    "LOSING_STREAK",
    `longestLosingStreak ${metrics.longestLosingStreak} > max ${criteria.maxLosingStreak}`);
  fail(metrics.confidenceCalibration01 >= criteria.minConfidenceCalibration01,
    "CONFIDENCE_CALIBRATION",
    `calibration ${metrics.confidenceCalibration01.toFixed(2)} < min ${criteria.minConfidenceCalibration01}`);
  fail(metrics.executionQuality01 >= criteria.minExecutionQuality01,
    "EXECUTION_QUALITY",
    `executionQuality ${metrics.executionQuality01.toFixed(2)} < min ${criteria.minExecutionQuality01}`);
  fail(metrics.riskCompliance01 >= criteria.minRiskCompliance01,
    "RISK_COMPLIANCE",
    `riskCompliance ${metrics.riskCompliance01.toFixed(2)} < min ${criteria.minRiskCompliance01}`);
  fail(metrics.falseApprovalRate01 <= criteria.maxFalseApprovalRate01,
    "FALSE_APPROVAL_RATE",
    `falseApprovalRate ${metrics.falseApprovalRate01.toFixed(2)} > max ${criteria.maxFalseApprovalRate01}`);
  fail(metrics.falseBlockRate01 <= criteria.maxFalseBlockRate01,
    "FALSE_BLOCK_RATE",
    `falseBlockRate ${metrics.falseBlockRate01.toFixed(2)} > max ${criteria.maxFalseBlockRate01}`);

  if (criteria.minFoldsPositive !== undefined) {
    const folds = metrics.foldExpectancyRs ?? [];
    const positive = folds.filter((f) => f > 0).length;
    fail(positive >= criteria.minFoldsPositive,
      "WALK_FORWARD_FOLDS",
      `positiveFolds ${positive} < min ${criteria.minFoldsPositive}`);
  }

  function fail(ok: boolean, check: string, why: string): void {
    if (ok) reasons.push(`${check}: ok (${why.replace(/^.*?\s/, '')})`);
    else { failedChecks.push(check); reasons.push(`${check}: FAIL — ${why}`); }
  }

  return {
    candidateId: metrics.candidateId,
    stage: metrics.stage,
    passed: failedChecks.length === 0,
    failedChecks,
    reasons,
  };
}

export function toStageResult(
  metrics: StageMetrics,
  check: CriteriaCheckResult,
  recordedAtIso: string,
): StageValidationResult {
  return {
    stage: metrics.stage,
    candidateId: metrics.candidateId,
    verdict: check.passed ? "PASS" : "FAIL",
    failedChecks: check.failedChecks,
    metrics,
    recordedAtIso,
    reasons: check.reasons,
    blockers: [],
  };
}
