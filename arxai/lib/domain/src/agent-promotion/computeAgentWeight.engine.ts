import {
  type AgentBucketStats, type AgentWeight,
  AGENT_PROMOTION_THRESHOLDS,
} from "./agentPromotion.types";

// computeAgentWeight — turn a bucket's (averageScore, sampleCount) into
// an authority weight for THIS context.
//
// Mechanism:
//   • trust01 = min(1, sqrt(sampleCount) / sqrt(fullSampleCount))
//   • rawWeight from averageScore: 50 → 1.0 (neutral),
//                                  100 → weightMax, 0 → weightMin
//   • blended weight = neutral * (1 - trust01) + rawWeight * trust01
//
// Low-sample agents stay near neutral (1.0) — the system doesn't promote
// or punish based on noise.
export function computeAgentWeight(bucket: AgentBucketStats | null): AgentWeight {
  const T = AGENT_PROMOTION_THRESHOLDS;
  const reasons: string[] = [];
  if (bucket === null || bucket.sampleCount === 0) {
    reasons.push("no samples in this context — neutral weight 1.0");
    return { agentId: "", contextKey: "", weight: T.weightNeutral, trust01: 0, reasons };
  }

  const trust01 = Math.min(1, Math.sqrt(bucket.sampleCount) / Math.sqrt(T.trustFullSampleCount));

  // Map averageScore [0..100] linearly to [weightMin..weightMax]:
  //   averageScore 0   → weightMin
  //   averageScore 50  → neutral (1.0)
  //   averageScore 100 → weightMax
  const span = T.weightMax - T.weightMin;
  const rawWeight = T.weightMin + (bucket.averageScore / 100) * span;

  const weight = T.weightNeutral * (1 - trust01) + rawWeight * trust01;
  reasons.push(
    `${bucket.sampleCount} samples (trust ${trust01.toFixed(2)}), ` +
    `avg score ${bucket.averageScore.toFixed(0)} → weight ${weight.toFixed(2)} ` +
    `(raw ${rawWeight.toFixed(2)} blended toward neutral)`,
  );
  return { agentId: bucket.agentId, contextKey: bucket.contextKey, weight, trust01, reasons };
}
