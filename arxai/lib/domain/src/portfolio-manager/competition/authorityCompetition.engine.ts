import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Authority Competition — agents compete for a fixed number of "seats".
// Top-N agents by composite score get full vote weight; lower ranks
// progressively decay.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const AuthorityCompetitionInputSchema = z.object({
  agentId: z.string().min(1),
  calibration01: z.number().min(0).max(1),
  recentAccuracy01: z.number().min(0).max(1),
  trackRecord01: z.number().min(0).max(1),
});
export type AuthorityCompetitionInput = z.infer<typeof AuthorityCompetitionInputSchema>;

export interface AuthorityCompetitionOutput {
  ranked: ReadonlyArray<{
    agentId: string; rank: number; voteWeight01: number; reasons: string[];
  }>;
}

export function competeAgentAuthority(
  inputs: ReadonlyArray<AuthorityCompetitionInput>,
  seats: number,
): AuthorityCompetitionOutput {
  const scored = inputs.map((a) => {
    const score = clamp01(
      0.35 * a.calibration01 + 0.35 * a.recentAccuracy01 + 0.30 * a.trackRecord01,
    );
    return { agent: a, score };
  }).sort((x, y) => y.score - x.score);
  const k = Math.max(1, Math.min(seats, scored.length));
  return {
    ranked: scored.map((s, idx) => {
      const rank = idx + 1;
      let w: number;
      if (rank <= k) {
        w = clamp01(0.6 + s.score * 0.4); // top tier: 0.6..1.0
      } else {
        // losers decay from 0.5 → 0.1 by rank
        const losers = scored.length - k;
        const t = losers <= 1 ? 1 : (rank - k) / losers;
        w = clamp01(0.5 - t * 0.4);
      }
      return {
        agentId: s.agent.agentId,
        rank,
        voteWeight01: w,
        reasons: [
          `score ${s.score.toFixed(3)}, rank ${rank}/${scored.length} (seats ${k})`,
          `voteWeight ${w.toFixed(3)}`,
        ],
      };
    }),
  };
}
