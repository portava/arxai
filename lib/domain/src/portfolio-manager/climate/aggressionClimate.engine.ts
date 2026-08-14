import { z } from "zod/v4";
import { type AggressionLevel, AggressionLevelSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Aggression Climate — climate-driven downgrade of recommended aggression.
//
// Climate can only RESTRICT aggression, never raise it. This is monotonic
// against the base recommendation derived from reserve / drawdown.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const AggressionClimateInputSchema = z.object({
  climateScore01: z.number().min(0).max(1),
  baseAggression: AggressionLevelSchema,
});
export type AggressionClimateInput = z.infer<typeof AggressionClimateInputSchema>;

export interface AggressionClimateOutput {
  recommendedAggression: AggressionLevel;
  aggressionMultiplier01: number;
  downgraded: boolean;
  reasons: string[];
}

const ORDER: AggressionLevel[] = ["FROZEN", "OBSERVE_ONLY", "CONSERVATIVE", "BALANCED", "AGGRESSIVE"];

function climateCeiling(score01: number): AggressionLevel {
  if (score01 < 0.20) return "OBSERVE_ONLY";
  if (score01 < 0.40) return "CONSERVATIVE";
  if (score01 < 0.65) return "BALANCED";
  return "AGGRESSIVE";
}

export function applyAggressionClimate(i: AggressionClimateInput): AggressionClimateOutput {
  const score = clamp01(i.climateScore01);
  const ceiling = climateCeiling(score);
  // Downgrade base if it exceeds ceiling.
  const baseIdx = ORDER.indexOf(i.baseAggression);
  const ceilIdx = ORDER.indexOf(ceiling);
  const finalIdx = Math.min(baseIdx, ceilIdx);
  const recommended = ORDER[finalIdx]!;
  // Multiplier in [0.3, 1.2] driven by climate.
  const mult = 0.3 + score * 0.9;
  return {
    recommendedAggression: recommended,
    aggressionMultiplier01: mult,
    downgraded: finalIdx < baseIdx,
    reasons: [
      `climate ${score.toFixed(3)} → ceiling ${ceiling}`,
      `base ${i.baseAggression} → final ${recommended}` +
        (finalIdx < baseIdx ? " (climate downgrade)" : ""),
      `aggressionMultiplier ${mult.toFixed(3)}`,
    ],
  };
}
