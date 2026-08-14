import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Replay Priority — score historical episodes for re-replay value.
// "Surprising" or "rare" episodes should be re-played more than routine
// ones; recent disasters should outrank ancient routine wins.
//
// Score = w1·regimeRarity + w2·outcomeMagnitude + w3·calibrationSurprise
//       + w4·recencyDecay
// ═══════════════════════════════════════════════════════════════════════════

export const ReplayCandidateSchema = z.object({
  episodeId: z.string().min(1),
  regimeRarity01: z.number().min(0).max(1),  // 1 = rare regime
  outcomeMagnitudeR: z.number().min(0),      // |pnlR|
  calibrationSurprisePp: z.number().min(0),  // |predicted − realized| in pp
  ageDays: z.number().min(0),
});
export type ReplayCandidate = z.infer<typeof ReplayCandidateSchema>;

export const REPLAY_TUNING = {
  weights: { rarity: 0.30, magnitude: 0.30, surprise: 0.25, recency: 0.15 },
  // Magnitudes saturate above this R-multiple.
  magnitudeSaturationR: 3.0,
  surpriseSaturationPp: 50,
  // Recency: half-life in days (exponential).
  recencyHalfLifeDays: 14,
} as const;

export interface ReplayScoredCandidate {
  episodeId: string;
  score01: number;
  reasons: string[];
}

export function scoreReplay(c: ReplayCandidate): ReplayScoredCandidate {
  const W = REPLAY_TUNING.weights;
  const T = REPLAY_TUNING;
  const magnitude01  = clamp01(c.outcomeMagnitudeR / T.magnitudeSaturationR);
  const surprise01   = clamp01(c.calibrationSurprisePp / T.surpriseSaturationPp);
  const recency01    = Math.pow(0.5, c.ageDays / T.recencyHalfLifeDays);
  const score = c.regimeRarity01 * W.rarity
              + magnitude01      * W.magnitude
              + surprise01       * W.surprise
              + recency01        * W.recency;
  return {
    episodeId: c.episodeId,
    score01: clamp01(score),
    reasons: [
      `rarity ${c.regimeRarity01.toFixed(3)} × ${W.rarity}`,
      `magnitude ${magnitude01.toFixed(3)} (|R|=${c.outcomeMagnitudeR.toFixed(2)}) × ${W.magnitude}`,
      `surprise ${surprise01.toFixed(3)} (pp=${c.calibrationSurprisePp.toFixed(1)}) × ${W.surprise}`,
      `recency ${recency01.toFixed(3)} (age=${c.ageDays.toFixed(1)}d) × ${W.recency}`,
      `score ${score.toFixed(3)}`,
    ],
  };
}

export interface ReplayPriorityResult {
  ranked: ReplayScoredCandidate[];
  reasons: string[];
}

export function rankReplayCandidates(candidates: readonly ReplayCandidate[]): ReplayPriorityResult {
  const scored = candidates.map(scoreReplay);
  scored.sort((a, b) => b.score01 - a.score01);
  return {
    ranked: scored,
    reasons: [`ranked ${scored.length} replay candidates by composite priority`],
  };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
