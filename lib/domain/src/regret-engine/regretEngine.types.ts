import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Regret Engine — track every decision (executed, reduced, blocked) and
// classify the regret kind once the realized OR counterfactual outcome is
// known. Builds a confidence calibration curve from graded predictions
// and emits a correction map that future predictions can consult.
//
// Self-contained — no imports from decision-qa or do-nothing. Caller
// supplies the outcome (counterfactual outcome from decision-qa, realized
// outcome from order-execution).
// ═══════════════════════════════════════════════════════════════════════════

export const RegretActionSchema = z.enum(["APPROVE_FULL", "APPROVE_REDUCED", "REJECT"]);
export type RegretAction = z.infer<typeof RegretActionSchema>;

export const RegretKindSchema = z.enum([
  "NO_REGRET",
  "REGRET_TAKING_LOSER",        // approved full, lost
  "REGRET_REDUCING_WINNER",     // approved reduced, would have won big at full
  "REGRET_BLOCKING_WINNER",     // rejected, counterfactual was a clear win
]);
export type RegretKind = z.infer<typeof RegretKindSchema>;

export interface RegretInput {
  decisionId: string;
  recordedAt: string;
  action: RegretAction;
  outcomePnlR: number;            // realized (for executed) OR counterfactual (for REJECT)
  outcomeWasCounterfactual: boolean;
  predictedConfidence: number;    // 0..100, the judge's confidence at decision time
}

export interface RegretRecord extends RegretInput {
  regretKind: RegretKind;
  regretMagnitudeR: number;       // ≥ 0; how much we regret it (0 if NO_REGRET)
  reasons: string[];
}

// ── Calibration ──────────────────────────────────────────────────────────
export interface ConfidenceBucket {
  bucketLow: number;              // inclusive (0..100)
  bucketHigh: number;             // exclusive, except top bucket inclusive
  midpoint: number;
  sampleCount: number;
  winCount: number;
  actualWinRate01: number;        // winCount / sampleCount, 0 when no samples
  predictedWinRate01: number;     // midpoint / 100
  calibrationErrorPp: number;     // (actual − predicted) × 100, signed; 0 if no samples
}

export interface CalibrationCurve {
  buckets: ConfidenceBucket[];
  meanAbsoluteCalibrationErrorPp: number;     // MACE in percentage points
  totalSamples: number;
  reasons: string[];
}

export interface CalibrationCorrection {
  // Maps each bucket midpoint to a delta in PERCENTAGE POINTS to add to
  // future raw confidence values that fall in that bucket. Negative delta
  // = downgrade overconfident predictions; positive = upgrade underconfident.
  deltasByMidpoint: Record<number, number>;
  trustFloorSamples: number;      // buckets below this sample count → no correction
  reasons: string[];
}

// ── Aggregate scorecard ──────────────────────────────────────────────────
export interface RegretSummary {
  totalRecords: number;
  byKind: Partial<Record<RegretKind, number>>;
  totalRegretR: number;           // sum of regretMagnitudeR
  meanRegretR: number;
  reasons: string[];
}

export interface RegretStorePort {
  put(record: RegretRecord): Promise<void>;
  list(filter?: { since?: Date; until?: Date }): Promise<RegretRecord[]>;
}

export const REGRET_THRESHOLDS = {
  neutralBandR: 0.20,             // |pnl| ≤ this → scratch (no regret either way)
  highMagnitudeR: 1.0,            // ≥ this → bigger regret weight
  bucketWidth: 10,                // 10pp confidence buckets
  calibrationTrustFloorSamples: 10,
} as const;
