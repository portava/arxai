// ═══════════════════════════════════════════════════════════════════════════
// Discipline Score
//
// Composes observable signals into a single discipline scalar:
//   • overrideQualityScore01     (higher = better)
//   • postLossRiskScore01        (lower  = better discipline)
//   • ruleViolations counted     (lower  = better discipline)
//   • behavior pattern severity  (lower  = better discipline)
//
// disciplineScore01 in [0..1], higher = better.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { BehaviorPatternHit } from "./behaviorPattern.engine";
import type { DnaSeverity } from "./traderProfile.types";

export const DisciplineLevelSchema = z.enum([
  "EXEMPLARY", "STRONG", "ADEQUATE", "WEAK", "CRITICAL",
]);
export type DisciplineLevel = z.infer<typeof DisciplineLevelSchema>;

export const DisciplineScoreSchema = z.object({
  score01: z.number().min(0).max(1),
  level: DisciplineLevelSchema,
  components: z.object({
    overrideQuality01: z.number().min(0).max(1),
    postLossControl01: z.number().min(0).max(1),
    ruleAdherence01:   z.number().min(0).max(1),
    behaviorRestraint01: z.number().min(0).max(1),
  }),
  reasons: z.array(z.string()),
});
export type DisciplineScore = z.infer<typeof DisciplineScoreSchema>;

const SEV_TO_01: Record<DnaSeverity, number> = {
  NONE: 0, LOW: 0.20, MEDIUM: 0.45, HIGH: 0.70, CRITICAL: 1.0,
};

export interface DisciplineInput {
  overrideQualityScore01: number;     // higher = better
  postLossRiskScore01: number;        // higher = worse
  ruleViolationsLast24h: number;      // count
  patterns: BehaviorPatternHit[];
}

export function computeDisciplineScore(input: DisciplineInput): DisciplineScore {
  const overrideQuality01   = clamp01(input.overrideQualityScore01);
  const postLossControl01   = clamp01(1 - input.postLossRiskScore01);
  const ruleAdherence01     = clamp01(1 - Math.min(1, input.ruleViolationsLast24h / 5));
  const worstBehavior01     = input.patterns
    .filter(p => p.severity !== "NONE")
    .map(p => SEV_TO_01[p.severity])
    .reduce((a, b) => Math.max(a, b), 0);
  const behaviorRestraint01 = clamp01(1 - worstBehavior01);

  // Weighted blend — rule adherence is the heaviest single weight.
  const score01 = clamp01(
    0.30 * overrideQuality01
    + 0.30 * ruleAdherence01
    + 0.20 * postLossControl01
    + 0.20 * behaviorRestraint01,
  );

  let level: DisciplineLevel;
  if (score01 >= 0.85)      level = "EXEMPLARY";
  else if (score01 >= 0.70) level = "STRONG";
  else if (score01 >= 0.50) level = "ADEQUATE";
  else if (score01 >= 0.30) level = "WEAK";
  else                      level = "CRITICAL";

  const reasons = [
    `override quality ${overrideQuality01.toFixed(2)} · rule adherence ${ruleAdherence01.toFixed(2)} · post-loss control ${postLossControl01.toFixed(2)} · behavior restraint ${behaviorRestraint01.toFixed(2)}`,
    `discipline ${score01.toFixed(2)} → ${level}`,
  ];

  return {
    score01, level,
    components: { overrideQuality01, postLossControl01, ruleAdherence01, behaviorRestraint01 },
    reasons,
  };
}

function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
