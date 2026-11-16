import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Strategy Competition — strategies compete dynamically for allocation.
// Top-K by composite score get full multiplier; lower ranks are
// progressively cut. Multiplier in [0.2, 1.0].
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const CompetitionInputSchema = z.object({
  strategyId: StrategyIdSchema,
  compositeScore01: z.number().min(0).max(1),
});
export type CompetitionInput = z.infer<typeof CompetitionInputSchema>;

export const COMPETITION_BOUNDS = { min: 0.2, max: 1.0 } as const;

export interface StrategyCompetitionOutput {
  ranked: ReadonlyArray<{
    strategyId: string; rank: number; multiplier: number; reasons: string[];
  }>;
  multipliersById: ReadonlyMap<string, number>;
}

export function rankStrategiesByCompetition(
  inputs: ReadonlyArray<CompetitionInput>,
  topK: number,
): StrategyCompetitionOutput {
  const sorted = [...inputs].sort((a, b) => b.compositeScore01 - a.compositeScore01);
  const k = Math.max(1, Math.min(topK, sorted.length));
  const map = new Map<string, number>();
  const ranked = sorted.map((s, idx) => {
    const rank = idx + 1;
    let m: number;
    if (rank <= k) {
      m = COMPETITION_BOUNDS.max;
    } else {
      // Linear decay from max → min over the losers.
      const losers = sorted.length - k;
      const t = losers <= 1 ? 1 : (rank - k) / losers;
      m = COMPETITION_BOUNDS.max - t * (COMPETITION_BOUNDS.max - COMPETITION_BOUNDS.min);
    }
    m = clamp01(m);
    map.set(s.strategyId, m);
    return {
      strategyId: s.strategyId, rank, multiplier: m,
      reasons: [`rank ${rank}/${sorted.length} (top ${k}) → multiplier ${m.toFixed(3)}`],
    };
  });
  return { ranked, multipliersById: map };
}
