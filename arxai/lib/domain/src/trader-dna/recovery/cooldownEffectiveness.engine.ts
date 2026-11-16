// ═══════════════════════════════════════════════════════════════════════════
// Cooldown Effectiveness
//
// Per-cooldown-record measurement: did the cooldown duration produce a
// material improvement, and what duration tends to produce the best
// outcome for THIS trader? Returns recommended next cooldown duration.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { measureRecoveryEffectiveness } from "./recoveryEffectiveness.engine";

export const CooldownRecordSchema = z.object({
  startedAt:           z.string(),
  durationMinutes:     z.number().nonnegative(),
  preBehaviorRisk:     z.number().min(0).max(1),
  postBehaviorRisk:    z.number().min(0).max(1),
  preDiscipline:       z.number().min(0).max(1),
  postDiscipline:      z.number().min(0).max(1),
  preCognitiveRisk:    z.number().min(0).max(1).default(0),
  postCognitiveRisk:   z.number().min(0).max(1).default(0),
}).strict();
export type CooldownRecord = z.infer<typeof CooldownRecordSchema>;

export const CooldownEffectivenessSchema = z.object({
  sample: z.number().int().nonnegative(),
  averageEffectiveness01: z.number().min(0).max(1),
  effectiveCount: z.number().int().nonnegative(),
  ineffectiveCount: z.number().int().nonnegative(),
  bestDurationMinutes: z.number().nullable(),
  recommendedNextDurationMinutes: z.number().nonnegative(),
  neutralLanguage: z.string(),
});
export type CooldownEffectivenessReport = z.infer<typeof CooldownEffectivenessSchema>;

export function analyzeCooldownEffectiveness(records: CooldownRecord[]): CooldownEffectivenessReport {
  if (!records.length) {
    return { sample: 0, averageEffectiveness01: 0.5, effectiveCount: 0, ineffectiveCount: 0,
      bestDurationMinutes: null, recommendedNextDurationMinutes: 30,
      neutralLanguage: "No cooldown history — defaulting to 30 minutes." };
  }
  let sumEff = 0, eff = 0, ineff = 0;
  let bestEff = -1, bestDur: number | null = null;
  for (const r of records) {
    const m = measureRecoveryEffectiveness({
      eventKind: "COOLDOWN",
      preMetrics:  { behaviorRiskScore01: r.preBehaviorRisk,  disciplineScore01: r.preDiscipline,  cognitiveRisk01: r.preCognitiveRisk },
      postMetrics: { behaviorRiskScore01: r.postBehaviorRisk, disciplineScore01: r.postDiscipline, cognitiveRisk01: r.postCognitiveRisk },
    });
    sumEff += m.effectivenessScore01;
    if (m.classification === "EFFECTIVE") eff++;
    if (m.classification === "INEFFECTIVE" || m.classification === "COUNTERPRODUCTIVE") ineff++;
    if (m.effectivenessScore01 > bestEff) { bestEff = m.effectivenessScore01; bestDur = r.durationMinutes; }
  }
  const avg = sumEff / records.length;
  // Recommend next: if average is poor, lengthen 50%; if strong, keep best; else slight nudge.
  const recommended = avg < 0.45 ? Math.round((bestDur ?? 30) * 1.5)
                    : avg > 0.65 ? Math.round(bestDur ?? 30)
                    : Math.round((bestDur ?? 30) * 1.10);
  return {
    sample: records.length,
    averageEffectiveness01: round2(avg),
    effectiveCount: eff, ineffectiveCount: ineff,
    bestDurationMinutes: bestDur,
    recommendedNextDurationMinutes: recommended,
    neutralLanguage: `Avg effectiveness ${avg.toFixed(2)} across ${records.length} cooldowns; best at ${bestDur ?? "n/a"}m. Recommend ${recommended}m next.`,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
