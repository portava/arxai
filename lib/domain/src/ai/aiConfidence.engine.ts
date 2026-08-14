import type { AiConfidenceFactor } from "./aiInsight.types";

export interface ConfidenceReport {
  score: number;            // 0..100
  weightedScore: number;    // sum(weight*score) / sum(weight)
  topContributors: AiConfidenceFactor[];
  topDetractors: AiConfidenceFactor[];
}

// Weighted average of confidence factors. Weights need not sum to 1; we
// normalize. Empty input returns 0.
export function computeConfidence(factors: AiConfidenceFactor[]): ConfidenceReport {
  if (factors.length === 0) {
    return { score: 0, weightedScore: 0, topContributors: [], topDetractors: [] };
  }
  const totalWeight = factors.reduce((acc, f) => acc + f.weight, 0);
  const weightedSum = factors.reduce((acc, f) => acc + f.weight * f.score, 0);
  const weighted = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const sorted = [...factors].sort((a, b) => b.score - a.score);
  return {
    score: Math.round(weighted),
    weightedScore: weighted,
    topContributors: sorted.slice(0, 3),
    topDetractors: sorted.slice(-3).reverse(),
  };
}

// Apply a discount factor to confidence based on adverse market context.
// Used when news risk or extreme volatility is present.
export function discountConfidence(score: number, penalties: number[]): number {
  const total = penalties.reduce((acc, p) => acc + p, 0);
  return Math.max(0, Math.min(100, score - total));
}
