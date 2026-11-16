// ═══════════════════════════════════════════════════════════════════════════
// Restriction Effectiveness
//
// Per-restriction history: which restrictions actually improved the
// trader's discipline / risk profile. Output ranks restrictions and
// recommends the most effective set for next prescription.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { measureRecoveryEffectiveness } from "./recoveryEffectiveness.engine";

export const RestrictionRecordSchema = z.object({
  restriction: z.string(),
  appliedAt:   z.string(),
  preBehaviorRisk:  z.number().min(0).max(1),
  postBehaviorRisk: z.number().min(0).max(1),
  preDiscipline:    z.number().min(0).max(1),
  postDiscipline:   z.number().min(0).max(1),
  preCognitiveRisk:  z.number().min(0).max(1).default(0),
  postCognitiveRisk: z.number().min(0).max(1).default(0),
}).strict();
export type RestrictionRecord = z.infer<typeof RestrictionRecordSchema>;

export const RestrictionRankingSchema = z.object({
  restriction: z.string(),
  sample: z.number().int().nonnegative(),
  averageEffectiveness01: z.number().min(0).max(1),
});
export type RestrictionRanking = z.infer<typeof RestrictionRankingSchema>;

export const RestrictionEffectivenessReportSchema = z.object({
  sample: z.number().int().nonnegative(),
  rankings: z.array(RestrictionRankingSchema),
  recommended: z.array(z.string()),
  notRecommended: z.array(z.string()),
  neutralLanguage: z.string(),
});
export type RestrictionEffectivenessReport = z.infer<typeof RestrictionEffectivenessReportSchema>;

export function analyzeRestrictionEffectiveness(records: RestrictionRecord[]): RestrictionEffectivenessReport {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const r of records) {
    const m = measureRecoveryEffectiveness({
      eventKind: "RESTRICTION",
      preMetrics:  { behaviorRiskScore01: r.preBehaviorRisk,  disciplineScore01: r.preDiscipline,  cognitiveRisk01: r.preCognitiveRisk },
      postMetrics: { behaviorRiskScore01: r.postBehaviorRisk, disciplineScore01: r.postDiscipline, cognitiveRisk01: r.postCognitiveRisk },
    });
    const b = buckets.get(r.restriction) ?? { sum: 0, n: 0 };
    b.sum += m.effectivenessScore01; b.n += 1;
    buckets.set(r.restriction, b);
  }
  const rankings: RestrictionRanking[] = [...buckets.entries()].map(([k, v]) => ({
    restriction: k, sample: v.n, averageEffectiveness01: round2(v.sum / Math.max(1, v.n)),
  })).sort((a, b) => b.averageEffectiveness01 - a.averageEffectiveness01);
  const recommended    = rankings.filter(r => r.averageEffectiveness01 >= 0.60).map(r => r.restriction);
  const notRecommended = rankings.filter(r => r.averageEffectiveness01 <= 0.40).map(r => r.restriction);
  return {
    sample: records.length, rankings, recommended, notRecommended,
    neutralLanguage: `${rankings.length} restriction kinds analyzed; ${recommended.length} effective, ${notRecommended.length} ineffective.`,
  };
}
function round2(n: number) { return Math.round(n * 100) / 100; }
