import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Specialty Score — does this agent have a proven edge in a SPECIFIC
// regime / symbol pair, vs. being a mediocre generalist? We track per-bucket
// expectancy, then collapse to a single 0..1 score = "best bucket"
// dominance, weighted by how concentrated the agent's activity is.
// ═══════════════════════════════════════════════════════════════════════════

export const RegimeBucketSchema = z.object({
  symbol: z.string().min(1),
  regime: z.string().min(1),                 // e.g. "TREND_UP", "CHOP"
  sampleCount: z.int().nonnegative(),
  expectancyR: z.number(),                   // average pnlR in this bucket
});
export type RegimeBucket = z.infer<typeof RegimeBucketSchema>;

export const SpecialtyInputsSchema = z.object({
  agentId: z.string().min(1),
  buckets: z.array(RegimeBucketSchema),
});
export type SpecialtyInputs = z.infer<typeof SpecialtyInputsSchema>;

export const SPECIALTY_TUNING = {
  minBucketSamples: 30,                      // ignore noisy buckets
  expectancyForFullCredit: 0.30,             // R-mult that maps to score 1
  // Concentration bonus: agents that focus on few buckets get a boost,
  // generalists get a small penalty (encourages real specialization).
  concentrationBonusMax: 0.15,
} as const;

export interface SpecialtyScoreResult {
  score01: number;
  bestBucket: RegimeBucket | null;
  qualifyingBuckets: number;
  reasons: string[];
  blockers: string[];
}

export function computeSpecialtyScore(i: SpecialtyInputs): SpecialtyScoreResult {
  const T = SPECIALTY_TUNING;
  const reasons: string[] = [];
  const blockers: string[] = [];

  const qualifying = i.buckets.filter((b) => b.sampleCount >= T.minBucketSamples);
  if (qualifying.length === 0) {
    blockers.push(`no bucket has ≥ ${T.minBucketSamples} samples — specialty cannot be measured`);
    return { score01: 0, bestBucket: null, qualifyingBuckets: 0, reasons, blockers };
  }

  const best = qualifying.reduce((a, b) => (b.expectancyR > a.expectancyR ? b : a));
  const baseScore = clamp01(best.expectancyR / T.expectancyForFullCredit);

  // Concentration bonus: 1 bucket → full bonus; many buckets → 0.
  // Defensive cap so it cannot push score above 1.
  const concentration = 1 / qualifying.length;
  const bonus = T.concentrationBonusMax * concentration;
  const score01 = clamp01(baseScore + bonus * baseScore);

  reasons.push(
    `evaluated ${qualifying.length} qualifying buckets (≥ ${T.minBucketSamples} samples)`,
    `best bucket ${best.symbol}/${best.regime} expectancyR=${best.expectancyR.toFixed(3)}`,
    `base score ${baseScore.toFixed(3)} + concentration bonus ${(bonus * baseScore).toFixed(3)}`,
    `final specialty ${score01.toFixed(3)}`,
  );
  if (qualifying.length > 5) {
    reasons.push(`agent is more generalist than specialist (${qualifying.length} active buckets)`);
  }
  return { score01, bestBucket: best, qualifyingBuckets: qualifying.length, reasons, blockers };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
