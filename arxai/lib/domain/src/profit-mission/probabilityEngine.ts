// Profit Mission — pure probability engine (MissionProbabilityScore).
//
// Produces target-hit / drawdown / failure ESTIMATES with best/expected/worst
// projections, a confidence label, and sample-size warnings. Every number is a
// labelled estimate — never a promise. PURE and DETERMINISTIC.
//
// Phase 1 has no historical/backtest sample wired, so confidence is honest
// (low) and a sample-size warning is always surfaced when sampleSize is small.

import type {
  ConfidenceLabel,
  FeasibilityVerdict,
  MissionMath,
  MissionProbabilityScore,
  RiskProfile,
  ScenarioProjection,
} from "./types.js";

/** Below this sample count the estimate carries a sample-size warning. */
const MIN_RELIABLE_SAMPLE = 30;

/**
 * Exact honest note shown when there is NO historical sample. Every projected
 * value is forward math, not a backtested probability. Locked by the unit suite.
 */
const PLANNING_PROJECTION_NOTE =
  "No historical sample is available yet. These values are mathematical " +
  "planning projections based on your inputs, not backtested probabilities.";

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function round(n: number): number {
  return Math.round(n);
}

/** Risk-profile drawdown fractions for the worst-case scenario estimate. */
const DRAWDOWN_FRACTION: Record<RiskProfile, number> = {
  conservative: 0.1,
  balanced: 0.2,
  aggressive: 0.35,
  extreme: 0.55,
};

function confidenceFor(sampleSize: number): ConfidenceLabel {
  if (sampleSize >= 100) return "high";
  if (sampleSize >= MIN_RELIABLE_SAMPLE) return "medium";
  return "low";
}

export interface ProbabilityInput {
  math: MissionMath;
  feasibility: FeasibilityVerdict;
  riskProfile: RiskProfile;
  /** Historical samples behind the estimate; 0 in Phase 1. */
  sampleSize?: number;
}

function projection(startingAmount: number, endingValue: number): ScenarioProjection {
  const profit = endingValue - startingAmount;
  const returnPct = startingAmount > 0 ? (profit / startingAmount) * 100 : 0;
  return { endingValue, profit, returnPct };
}

export function evaluateProbability(input: ProbabilityInput): MissionProbabilityScore {
  const { math, feasibility, riskProfile } = input;
  const sampleSize = Math.max(0, Math.floor(input.sampleSize ?? 0));

  // Target-hit estimate: damped feasibility (honest — below feasibility), with
  // a small penalty for an aggressive/extreme chosen profile.
  let targetHit = feasibility.feasibilityScore * 0.85;
  if (riskProfile === "aggressive") targetHit -= 5;
  if (riskProfile === "extreme") targetHit -= 10;
  // Fail-closed: an unassessable mission has no positive target-hit estimate.
  if (feasibility.tier === "Unreasonable") targetHit = Math.min(targetHit, 5);
  const targetHitProbability = clamp(round(targetHit), 0, 100);

  // Drawdown risk estimate scales with the chosen risk profile and the overall
  // risk score of the verdict.
  const drawdownRisk = clamp(
    round(DRAWDOWN_FRACTION[riskProfile] * 100 * 0.6 + feasibility.riskScore * 0.4),
    0,
    100,
  );

  const failureProbability = clamp(100 - targetHitProbability, 0, 100);

  // Scenario projections (estimates):
  //  - expected: a fraction of the goal gap proportional to target-hit odds.
  //  - best: reaching the target (capped at the goal in Phase 1).
  //  - worst: a risk-profile-sized drawdown from the starting amount.
  const expectedEnding =
    math.startingAmount + math.requiredProfit * (targetHitProbability / 100);
  const bestEnding = math.targetAmount;
  const worstEnding = math.startingAmount * (1 - DRAWDOWN_FRACTION[riskProfile]);

  const confidence = confidenceFor(sampleSize);
  const sampleSizeWarnings: string[] = [];
  if (sampleSize < MIN_RELIABLE_SAMPLE) {
    sampleSizeWarnings.push(
      sampleSize === 0
        ? "No historical sample yet — these are mathematical planning projections from your inputs, not backtested results or a track record."
        : `Limited historical sample (${sampleSize}); this projection has low confidence.`,
    );
  }

  return {
    targetHitProbability,
    drawdownRisk,
    failureProbability,
    projections: {
      best: projection(math.startingAmount, bestEnding),
      expected: projection(math.startingAmount, expectedEnding),
      worst: projection(math.startingAmount, worstEnding),
    },
    confidence,
    sampleSize,
    sampleSizeWarnings,
    planningProjectionOnly: sampleSize === 0,
    planningProjectionNote: sampleSize === 0 ? PLANNING_PROJECTION_NOTE : "",
    isEstimate: true,
    disclaimer:
      "All values are projections based on the inputs and pace, not a promise of profit. " +
      "Actual results vary and possible loss is real.",
  };
}
