import {
  type PrioritySignals, type PriorityScore, clamp01,
} from "./validationEfficiency.types";

// ═══════════════════════════════════════════════════════════════════════════
// Test Priority — composite [0,1] score that decides which candidates jump
// the queue. Pure. Risk and execution-difficulty are inverted (higher raw
// = lower contribution). Weights sum to 1.0.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_PRIORITY_WEIGHTS = {
  potentialEdge:        0.30,
  riskInverse:          0.15,
  urgency:              0.10,
  marketRelevance:      0.20,
  replayStrength:       0.15,
  executionEase:        0.10,
} as const;
export type PriorityWeights = typeof DEFAULT_PRIORITY_WEIGHTS;

export function computeTestPriority(
  signals: PrioritySignals,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): PriorityScore {
  const reasons: string[] = [];
  // Defensive: clamp every input. Bad inputs are flagged as reasons rather
  // than silently corrupting the score.
  const edge   = clamp01(signals.potentialEdge01);
  const riskI  = clamp01(1 - signals.riskScore01);
  const urg    = clamp01(signals.urgency01);
  const rel    = clamp01(signals.marketRelevance01);
  const replay = clamp01(signals.replayStrength01);
  const ease   = clamp01(1 - signals.executionDifficulty01);

  const wSum = weights.potentialEdge + weights.riskInverse + weights.urgency
    + weights.marketRelevance + weights.replayStrength + weights.executionEase;
  if (Math.abs(wSum - 1) > 1e-6) {
    reasons.push(`weights sum to ${wSum.toFixed(3)} (expected 1.0) — score is normalised by sum`);
  }

  const raw =
      edge   * weights.potentialEdge
    + riskI  * weights.riskInverse
    + urg    * weights.urgency
    + rel    * weights.marketRelevance
    + replay * weights.replayStrength
    + ease   * weights.executionEase;
  const score01 = clamp01(wSum > 0 ? raw / wSum : 0);

  reasons.push(
    `edge ${edge.toFixed(2)} · risk⁻¹ ${riskI.toFixed(2)} · urg ${urg.toFixed(2)} · ` +
    `rel ${rel.toFixed(2)} · replay ${replay.toFixed(2)} · ease ${ease.toFixed(2)} → ${score01.toFixed(3)}`,
  );

  return {
    candidateId: signals.candidateId,
    score01,
    components: {
      potentialEdge: edge, riskInverse: riskI, urgency: urg,
      marketRelevance: rel, replayStrength: replay, executionEase: ease,
    },
    reasons,
  };
}

// Convenience for the queue: rank a list of (candidate, score) pairs.
export function compareByPriorityDesc(a: PriorityScore, b: PriorityScore): number {
  return b.score01 - a.score01;
}
