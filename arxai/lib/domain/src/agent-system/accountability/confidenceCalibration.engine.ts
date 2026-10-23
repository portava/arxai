// confidenceCalibration — given a stream of past performance records for one
// agent, compute confidence-vs-empirical-success bins and a mean absolute
// calibration error. An agent is "honest" when its self-reported confidence
// closely matches its empirical hit rate (mean abs error ≤ 0.15).

import type {
  AgentCalibrationReport, AgentPerformanceRecord, CalibrationBucket,
} from "./agentPerformance.types";

const BUCKETS: Array<[number, number]> = [
  [0.0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001],
];

function isPositiveOutcome(r: AgentPerformanceRecord): boolean {
  return r.outcome === "WIN" || r.outcome === "BLOCKED_CORRECTLY";
}

export function calibrate(args: {
  agentId: string;
  records: ReadonlyArray<AgentPerformanceRecord>;
  now: Date;
}): AgentCalibrationReport {
  const { agentId, records, now } = args;

  const buckets: CalibrationBucket[] = BUCKETS.map(([lo, hi]) => {
    const inBucket = records.filter(
      r => r.confidence01 >= lo && r.confidence01 < hi,
    );
    const count = inBucket.length;
    const positiveOutcomes = inBucket.filter(isPositiveOutcome).length;
    const empiricalRate01 = count === 0 ? 0 : positiveOutcomes / count;
    const expectedRate01 = (lo + Math.min(1, hi)) / 2;
    const calibrationError01 = count === 0 ? 0 : Math.abs(empiricalRate01 - expectedRate01);
    return {
      rangeLow01: lo, rangeHigh01: Math.min(1, hi),
      count, positiveOutcomes,
      empiricalRate01, expectedRate01, calibrationError01,
    };
  });

  // Sample-size-weighted mean absolute calibration error.
  const sampleSize = records.length;
  const weightedErr = sampleSize === 0
    ? 0
    : buckets.reduce((s, b) => s + b.calibrationError01 * b.count, 0) / sampleSize;

  // Honesty requires BOTH a non-trivial sample size AND a small mean error.
  // An insufficient sample is explicitly NOT honest — we cannot make a claim
  // about a calibrated agent without enough observations.
  return {
    agentId, buckets,
    meanAbsError01: +weightedErr.toFixed(4),
    isHonest: sampleSize >= 10 && weightedErr <= 0.15,
    sampleSize,
    recordedAtIso: now.toISOString(),
  };
}
