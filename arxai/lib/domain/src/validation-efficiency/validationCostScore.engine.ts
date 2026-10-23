import {
  type ValidationCostInput, type ValidationCostScore, clamp01,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Cost Score — composite [0,1] of estimated cost dimensions.
// Higher = more expensive to validate. Capital risk weighted heaviest
// because mis-spending capital is the most costly mistake. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_COST_WEIGHTS = {
  compute: 0.15,
  time:    0.20,
  data:    0.20,
  capital: 0.45,
} as const;
export type CostWeights = typeof DEFAULT_COST_WEIGHTS;

export function computeValidationCost(
  input: ValidationCostInput,
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
): ValidationCostScore {
  const reasons: string[] = [];
  const compute = clamp01(input.estComputeUnits01);
  const time    = clamp01(input.estTimeUnits01);
  const data    = clamp01(input.estDataUnits01);
  const capital = clamp01(input.estCapitalRisk01);

  const wSum = weights.compute + weights.time + weights.data + weights.capital;
  if (Math.abs(wSum - 1) > 1e-6) {
    reasons.push(`cost weights sum to ${wSum.toFixed(3)} — normalising by sum`);
  }
  const raw =
      compute * weights.compute
    + time    * weights.time
    + data    * weights.data
    + capital * weights.capital;
  const cost01 = clamp01(wSum > 0 ? raw / wSum : 0);

  reasons.push(
    `compute ${compute.toFixed(2)} · time ${time.toFixed(2)} · data ${data.toFixed(2)} · ` +
    `capital ${capital.toFixed(2)} → ${cost01.toFixed(3)}`,
  );

  return {
    candidateId: input.candidateId, cost01,
    components: { compute, time, data, capital },
    reasons,
  };
}
