import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Trust Score — composite 0..1 gating signal. Combines four pillars:
//   reputation        — earned through real outcomes
//   discipline        — adherence to rules
//   specialty         — proven edge in a specific regime/symbol
//   survivalQuality   — has the agent kept capital safe?
//
// Trust is a SOFT signal. Authority changes in this codebase still flow
// through the Risk Governor + Control Tower; trust never bypasses them.
// ═══════════════════════════════════════════════════════════════════════════

export const TrustInputsSchema = z.object({
  reputation01: z.number().min(0).max(1),
  discipline01: z.number().min(0).max(1),
  specialty01: z.number().min(0).max(1),
  survivalQuality01: z.number().min(0).max(1),
  sampleCount: z.int().nonnegative(),
});
export type TrustInputs = z.infer<typeof TrustInputsSchema>;

// Survival-first: discipline and survival quality dominate. Reputation and
// specialty are valuable but cannot override a poor discipline / survival
// record.
export const TRUST_WEIGHTS = {
  reputation: 0.20,
  discipline: 0.30,
  specialty: 0.15,
  survivalQuality: 0.35,
} as const;

// Sample-count confidence taper. Until we have enough graded samples, the
// trust score is pulled toward 0.5 (no opinion) regardless of inputs.
export const TRUST_CONFIDENCE = {
  minConfidentSamples: 100,
  fullConfidenceSamples: 500,
} as const;

export interface TrustScoreResult {
  score01: number;
  rawScore01: number;
  confidence01: number;
  reasons: string[];
  blockers: string[];
}

export function computeTrustScore(i: TrustInputs): TrustScoreResult {
  const W = TRUST_WEIGHTS;
  const C = TRUST_CONFIDENCE;
  const reasons: string[] = [];
  const blockers: string[] = [];

  const raw = i.reputation01 * W.reputation
            + i.discipline01 * W.discipline
            + i.specialty01 * W.specialty
            + i.survivalQuality01 * W.survivalQuality;

  // Confidence ramp: 0 below minConfidentSamples, 1 above fullConfidenceSamples.
  const confidence01 = clamp01(
    (i.sampleCount - C.minConfidentSamples) / (C.fullConfidenceSamples - C.minConfidentSamples),
  );

  // Pull toward 0.5 by (1 - confidence). Defensive: never UPGRADES a low raw
  // score by tapering — taper only moves toward 0.5 from either side.
  const score01 = 0.5 * (1 - confidence01) + raw * confidence01;

  reasons.push(
    `reputation ${i.reputation01.toFixed(3)} × ${W.reputation}`,
    `discipline ${i.discipline01.toFixed(3)} × ${W.discipline}`,
    `specialty ${i.specialty01.toFixed(3)} × ${W.specialty}`,
    `survivalQuality ${i.survivalQuality01.toFixed(3)} × ${W.survivalQuality}`,
    `raw composite ${raw.toFixed(3)}`,
    `samples ${i.sampleCount} → confidence ${confidence01.toFixed(3)}`,
    `tapered trust ${score01.toFixed(3)}`,
  );
  if (i.sampleCount < C.minConfidentSamples) {
    blockers.push(`insufficient samples ${i.sampleCount} < ${C.minConfidentSamples} for confident trust`);
  }
  return { score01: clamp01(score01), rawScore01: clamp01(raw), confidence01, reasons, blockers };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
