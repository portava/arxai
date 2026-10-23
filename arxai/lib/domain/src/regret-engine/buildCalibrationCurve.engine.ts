import {
  type CalibrationCurve, type ConfidenceBucket, type RegretRecord,
  REGRET_THRESHOLDS,
} from "./regretEngine.types";

// buildCalibrationCurve — bucket graded predictions by predicted
// confidence (default 10pp buckets), compute actual win rate per bucket,
// derive calibration error and the mean absolute calibration error (MACE).
//
// Win/loss definition uses the project-wide ±0.20R neutral band:
//   • outcomePnlR >  +0.20R → WIN
//   • outcomePnlR <  −0.20R → LOSS
//   • |outcomePnlR| ≤ 0.20R → SCRATCH (excluded from bucket counts —
//     scratches are inconclusive evidence about prediction accuracy)
//
// Top bucket is inclusive of 100; all others are [low, high). Buckets with
// zero samples are present but contribute 0 to MACE (they have no error
// to report yet).
export function buildCalibrationCurve(
  records: RegretRecord[],
  bucketWidth: number = REGRET_THRESHOLDS.bucketWidth,
): CalibrationCurve {
  const T = REGRET_THRESHOLDS;
  const reasons: string[] = [];

  if (bucketWidth <= 0 || bucketWidth > 100) {
    reasons.push(`invalid bucketWidth ${bucketWidth} — falling back to ${T.bucketWidth}`);
    bucketWidth = T.bucketWidth;
  }

  const bucketCount = Math.ceil(100 / bucketWidth);
  const buckets: ConfidenceBucket[] = Array.from({ length: bucketCount }, (_, i) => {
    const low = i * bucketWidth;
    const high = i === bucketCount - 1 ? 100 : low + bucketWidth;
    const midpoint = (low + (i === bucketCount - 1 ? 100 : low + bucketWidth)) / 2;
    return {
      bucketLow: low, bucketHigh: high, midpoint,
      sampleCount: 0, winCount: 0,
      actualWinRate01: 0,
      predictedWinRate01: midpoint / 100,
      calibrationErrorPp: 0,
    };
  });

  let totalSamples = 0;

  for (const r of records) {
    const pnl = r.outcomePnlR;
    if (Math.abs(pnl) <= T.neutralBandR) continue;       // scratch → exclude
    const c = Math.max(0, Math.min(100, r.predictedConfidence));
    // Top bucket is inclusive of 100; others use [low, high).
    let idx = Math.floor(c / bucketWidth);
    if (idx >= bucketCount) idx = bucketCount - 1;
    const b = buckets[idx]!;
    b.sampleCount += 1;
    if (pnl > T.neutralBandR) b.winCount += 1;
    totalSamples += 1;
  }

  let maceSum = 0;
  let bucketsWithSamples = 0;
  for (const b of buckets) {
    if (b.sampleCount === 0) continue;
    b.actualWinRate01 = b.winCount / b.sampleCount;
    b.calibrationErrorPp = (b.actualWinRate01 - b.predictedWinRate01) * 100;
    maceSum += Math.abs(b.calibrationErrorPp);
    bucketsWithSamples += 1;
  }

  const meanAbsoluteCalibrationErrorPp = bucketsWithSamples > 0 ? maceSum / bucketsWithSamples : 0;
  reasons.push(
    `${totalSamples} non-scratch samples across ${bucketsWithSamples} populated buckets; ` +
    `MACE ${meanAbsoluteCalibrationErrorPp.toFixed(1)}pp`,
  );

  return { buckets, meanAbsoluteCalibrationErrorPp, totalSamples, reasons };
}
