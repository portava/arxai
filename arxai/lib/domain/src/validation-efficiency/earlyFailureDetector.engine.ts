import {
  type EarlyFailureMetrics, type EarlyFailureDecision,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Early Failure Detector — kills weak candidates as soon as enough samples
// exist to make a defensible call. Pure. Refuses to kill below minTrades:
// returns kill=false with a structured reason so callers know the verdict
// is "not yet decidable".
// ═══════════════════════════════════════════════════════════════════════════

export interface EarlyFailureThresholds {
  minTrades: number;                             // sample-size guard
  minExpectancyR: number;
  maxDrawdownR: number;
  minConfidenceCalibration01: number;
  minRiskCompliance01: number;
}

export const DEFAULT_EARLY_FAILURE_THRESHOLDS: EarlyFailureThresholds = {
  minTrades: 30,
  minExpectancyR: -0.05,                          // tolerate slight negative
  maxDrawdownR: 10,
  minConfidenceCalibration01: 0.45,
  minRiskCompliance01: 0.75,
};

export function detectEarlyFailure(
  metrics: EarlyFailureMetrics,
  thresholds: EarlyFailureThresholds = DEFAULT_EARLY_FAILURE_THRESHOLDS,
): EarlyFailureDecision {
  const reasons: string[] = [];
  const failedChecks: string[] = [];
  const blockers: string[] = [];

  if (metrics.trades < thresholds.minTrades) {
    blockers.push(`undecidable: trades ${metrics.trades} < minTrades ${thresholds.minTrades}`);
    reasons.push(`waiting for more samples before kill decision`);
    return { candidateId: metrics.candidateId, kill: false, failedChecks, reasons, blockers };
  }

  if (metrics.expectancyR < thresholds.minExpectancyR) {
    failedChecks.push("MIN_EXPECTANCY");
    reasons.push(`MIN_EXPECTANCY: expectancyR ${metrics.expectancyR.toFixed(3)} < ${thresholds.minExpectancyR}`);
  }
  if (metrics.maxDrawdownR > thresholds.maxDrawdownR) {
    failedChecks.push("MAX_DRAWDOWN");
    reasons.push(`MAX_DRAWDOWN: ${metrics.maxDrawdownR.toFixed(2)} > ${thresholds.maxDrawdownR}`);
  }
  if (metrics.confidenceCalibration01 < thresholds.minConfidenceCalibration01) {
    failedChecks.push("CONFIDENCE_CALIBRATION");
    reasons.push(`CONFIDENCE_CALIBRATION: ${metrics.confidenceCalibration01.toFixed(2)} < ${thresholds.minConfidenceCalibration01}`);
  }
  if (metrics.riskCompliance01 < thresholds.minRiskCompliance01) {
    failedChecks.push("RISK_COMPLIANCE");
    reasons.push(`RISK_COMPLIANCE: ${metrics.riskCompliance01.toFixed(2)} < ${thresholds.minRiskCompliance01}`);
  }

  const kill = failedChecks.length > 0;
  if (!kill) reasons.push(`all early-failure checks passed at n=${metrics.trades}`);
  return { candidateId: metrics.candidateId, kill, failedChecks, reasons, blockers };
}
