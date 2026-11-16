// ═══════════════════════════════════════════════════════════════════════════
// Confidence Health — pure. Measures whether the model's stated confidence
// remains reliable over time, and flags overconfidence drift.
//
// Inputs: a recent rolling window of (predictedConfidence01, realizedOutcome01)
// pairs, plus an OPTIONAL baseline window for drift detection.
//
// We compute:
//   • calibrationError01 — mean absolute error between predicted and realized
//   • overconfidence01    — clamped mean of (predicted - realized)
//                            (positive = model overstates; negative = ignored)
//   • drift01             — |recent calibration - baseline calibration|
//   • status:
//       UNRELIABLE   — calibrationError > 0.30
//       OVERCONFIDENT — overconfidence  > 0.20
//       DRIFTING     — drift           > 0.15
//       HEALTHY      — otherwise
//   • healthScore01 — 1 - clamp(calibrationError + max(0, overconfidence)*0.5)
// ═══════════════════════════════════════════════════════════════════════════

export type ConfidenceHealthStatus = "HEALTHY" | "DRIFTING" | "OVERCONFIDENT" | "UNRELIABLE";

export interface ConfidencePair { predictedConfidence01: number; realizedOutcome01: number }
export interface ConfidenceHealthInput {
  candidateId: string;
  recent: ReadonlyArray<ConfidencePair>;
  baseline?: ReadonlyArray<ConfidencePair>;
  // Thresholds (defaults documented above)
  unreliableCalibrationErr01?: number;
  overconfidenceThreshold01?: number;
  driftThreshold01?: number;
}
export interface ConfidenceHealthResult {
  candidateId: string;
  status: ConfidenceHealthStatus;
  healthScore01: number;
  calibrationError01: number;
  overconfidence01: number;
  drift01: number;
  baselineCalibrationError01: number | null;
  meanPredicted01: number;
  meanRealized01: number;
  sampleSize: number;
  reasons: string[];
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
function meanOr0(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}
function calibration(pairs: ReadonlyArray<ConfidencePair>): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((s, p) => s + Math.abs(p.predictedConfidence01 - p.realizedOutcome01), 0) / pairs.length;
}

export function assessConfidenceHealth(i: ConfidenceHealthInput): ConfidenceHealthResult {
  const reasons: string[] = [];
  const unreliableThr = i.unreliableCalibrationErr01 ?? 0.30;
  const overThr       = i.overconfidenceThreshold01  ?? 0.20;
  const driftThr      = i.driftThreshold01           ?? 0.15;

  if (i.recent.length === 0) {
    reasons.push("no recent pairs — cannot judge confidence health (conservative score 0.5)");
    return {
      candidateId: i.candidateId,
      status: "DRIFTING",
      healthScore01: 0.5, calibrationError01: 0.5,
      overconfidence01: 0, drift01: 0,
      baselineCalibrationError01: null,
      meanPredicted01: 0, meanRealized01: 0, sampleSize: 0, reasons,
    };
  }

  const meanPred = meanOr0(i.recent.map(p => p.predictedConfidence01));
  const meanReal = meanOr0(i.recent.map(p => p.realizedOutcome01));
  const calibrationError = calibration(i.recent);
  const overconfidence = meanPred - meanReal;            // positive = overstated
  const baselineCal = i.baseline && i.baseline.length > 0 ? calibration(i.baseline) : null;
  const drift = baselineCal === null ? 0 : Math.abs(calibrationError - baselineCal);

  let status: ConfidenceHealthStatus = "HEALTHY";
  if (calibrationError > unreliableThr) status = "UNRELIABLE";
  else if (overconfidence > overThr)    status = "OVERCONFIDENT";
  else if (drift > driftThr)            status = "DRIFTING";

  const healthScore01 = clamp01(1 - (calibrationError + Math.max(0, overconfidence) * 0.5));
  reasons.push(`calibrationError ${calibrationError.toFixed(3)} | overconfidence ${overconfidence.toFixed(3)} | drift ${drift.toFixed(3)}`);
  reasons.push(`status ${status} (mean predicted ${meanPred.toFixed(2)} vs mean realized ${meanReal.toFixed(2)})`);
  if (baselineCal !== null) reasons.push(`baseline calibrationError ${baselineCal.toFixed(3)}`);

  return {
    candidateId: i.candidateId,
    status, healthScore01,
    calibrationError01: clamp01(calibrationError),
    overconfidence01: Math.max(-1, Math.min(1, overconfidence)),
    drift01: clamp01(drift),
    baselineCalibrationError01: baselineCal,
    meanPredicted01: clamp01(meanPred),
    meanRealized01: clamp01(meanReal),
    sampleSize: i.recent.length,
    reasons,
  };
}
