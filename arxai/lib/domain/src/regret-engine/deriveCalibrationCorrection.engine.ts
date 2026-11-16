import {
  type CalibrationCorrection, type CalibrationCurve,
  REGRET_THRESHOLDS,
} from "./regretEngine.types";

// deriveCalibrationCorrection — turn a CalibrationCurve into per-bucket
// adjustment deltas. Bucket midpoint → delta (pp) to add to raw confidence
// values that fall in that bucket.
//
// Rule: delta = calibrationErrorPp = (actualWinRate − predictedWinRate) × 100
//   • If 80% bucket actually wins 60%: delta = -20pp → downgrade future 80s
//   • If 50% bucket actually wins 70%: delta = +20pp → upgrade future 50s
//
// Buckets with sampleCount < trustFloorSamples get NO correction (the
// signal is too noisy). The applyCalibrationCorrection helper falls back
// to the raw value for those.
export function deriveCalibrationCorrection(
  curve: CalibrationCurve,
  trustFloorSamples: number = REGRET_THRESHOLDS.calibrationTrustFloorSamples,
): CalibrationCorrection {
  const reasons: string[] = [];
  const deltasByMidpoint: Record<number, number> = {};
  let appliedCount = 0;
  let skippedCount = 0;

  for (const b of curve.buckets) {
    if (b.sampleCount < trustFloorSamples) {
      skippedCount += 1;
      continue;
    }
    deltasByMidpoint[b.midpoint] = b.calibrationErrorPp;
    appliedCount += 1;
  }

  reasons.push(
    `${appliedCount} bucket(s) qualified for correction (≥ ${trustFloorSamples} samples); ` +
    `${skippedCount} bucket(s) skipped for low sample size`,
  );
  return { deltasByMidpoint, trustFloorSamples, reasons };
}

// applyCalibrationCorrection — convenience helper for callers. Locates the
// bucket containing rawConfidence and applies its delta if present.
// Returns the raw value unchanged when no correction exists.
export function applyCalibrationCorrection(
  rawConfidence: number,
  correction: CalibrationCorrection,
  bucketWidth: number = REGRET_THRESHOLDS.bucketWidth,
): { adjustedConfidence: number; appliedDeltaPp: number; reasons: string[] } {
  const reasons: string[] = [];
  const c = Math.max(0, Math.min(100, rawConfidence));
  const bucketCount = Math.ceil(100 / bucketWidth);
  let idx = Math.floor(c / bucketWidth);
  if (idx >= bucketCount) idx = bucketCount - 1;
  const low = idx * bucketWidth;
  const high = idx === bucketCount - 1 ? 100 : low + bucketWidth;
  const midpoint = (low + (idx === bucketCount - 1 ? 100 : low + bucketWidth)) / 2;

  const delta = correction.deltasByMidpoint[midpoint];
  if (delta === undefined) {
    reasons.push(`no correction for bucket [${low},${high}] — pass-through`);
    return { adjustedConfidence: c, appliedDeltaPp: 0, reasons };
  }
  const adjusted = Math.max(0, Math.min(100, c + delta));
  reasons.push(`bucket [${low},${high}] delta ${delta.toFixed(1)}pp → ${c.toFixed(1)} → ${adjusted.toFixed(1)}`);
  return { adjustedConfidence: adjusted, appliedDeltaPp: delta, reasons };
}
