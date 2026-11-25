// Profit Mission — pure probability engine (MissionProbabilityScore).
//
// Reports the chance of reaching the target ONLY when it is measured. ARX has
// no graded record of missions like this one (the server passes sampleSize 0
// and no outcomes), so the chance of reaching the target, the chance of falling
// short and the drawdown risk are null, never a formula over the required pace
// presented as a probability. The two scenarios are arithmetic from the inputs:
// reaching the target, and the selected risk profile's drawdown. PURE and
// DETERMINISTIC.

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
 * Exact honest note shown when there is NO historical sample. Locked by the
 * unit suite.
 */
const PLANNING_PROJECTION_NOTE =
  "No graded record of missions like this one exists yet, so no chance of " +
  "reaching the target is shown. The two scenarios are arithmetic from your " +
  "inputs, not backtested results.";

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
  /**
   * Graded outcomes of `sampleSize` comparable missions. The only source of a
   * shown chance: without them every chance is null (unmeasured).
   */
  outcomes?: { reachedTarget: number; drewDown: number };
}

function projection(startingAmount: number, endingValue: number): ScenarioProjection {
  const profit = endingValue - startingAmount;
  const returnPct = startingAmount > 0 ? (profit / startingAmount) * 100 : 0;
  return { endingValue, profit, returnPct };
}

export function evaluateProbability(input: ProbabilityInput): MissionProbabilityScore {
  const { math, riskProfile } = input;
  const sampleSize = Math.max(0, Math.floor(input.sampleSize ?? 0));

  // A chance is shown only from graded outcomes of at least MIN_RELIABLE_SAMPLE
  // comparable missions. Required pace, feasibility tier and risk profile are
  // inputs, not observations: a formula over them is not a probability.
  const o = input.outcomes;
  const measured = o != null && sampleSize >= MIN_RELIABLE_SAMPLE &&
    [o.reachedTarget, o.drewDown].every((n) => Number.isInteger(n) && n >= 0 && n <= sampleSize);
  const share = (n: number) => clamp(round((n / sampleSize) * 100), 0, 100);
  const targetHitProbability = measured ? share(o!.reachedTarget) : null;
  const failureProbability = targetHitProbability == null ? null : 100 - targetHitProbability;
  const drawdownRisk = measured ? share(o!.drewDown) : null;

  // Scenario projections (arithmetic from the inputs, not estimates):
  //  - best: reaching the target.
  //  - worst: a risk-profile-sized drawdown from the starting amount.
  // No "expected" ending: it would need measured ending values.
  const bestEnding = math.targetAmount;
  const worstEnding = math.startingAmount * (1 - DRAWDOWN_FRACTION[riskProfile]);

  // Confidence describes a measured chance; with none it stays low.
  const confidence = measured ? confidenceFor(sampleSize) : "low";
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
      expected: null,
      worst: projection(math.startingAmount, worstEnding),
    },
    confidence,
    sampleSize,
    sampleSizeWarnings,
    planningProjectionOnly: sampleSize === 0,
    planningProjectionNote: sampleSize === 0 ? PLANNING_PROJECTION_NOTE : "",
    isEstimate: true,
    disclaimer:
      "The scenarios are arithmetic from your inputs, not a promise of profit. " +
      "Actual results vary and possible loss is real.",
  };
}
