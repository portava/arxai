// ═══════════════════════════════════════════════════════════════════════════
// Recovery Effectiveness
//
// After a recovery event (cooldown completed, restriction lifted),
// measure whether the trader's *next* decisions improved on the metrics
// that triggered the intervention. Output is a 0..1 effectiveness score
// + classification.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const RecoveryEventKindSchema = z.enum([
  "COOLDOWN", "RESTRICTION", "PAPER_FALLBACK", "PRESCRIPTION_ISSUED",
]);
export type RecoveryEventKind = z.infer<typeof RecoveryEventKindSchema>;

export const RecoveryEffectivenessSchema = z.object({
  eventKind: RecoveryEventKindSchema,
  preMetrics:  z.object({
    behaviorRiskScore01: z.number().min(0).max(1),
    disciplineScore01:   z.number().min(0).max(1),
    cognitiveRisk01:     z.number().min(0).max(1),
  }),
  postMetrics: z.object({
    behaviorRiskScore01: z.number().min(0).max(1),
    disciplineScore01:   z.number().min(0).max(1),
    cognitiveRisk01:     z.number().min(0).max(1),
  }),
  improvementDeltas: z.object({
    behaviorRisk: z.number(),
    discipline:   z.number(),
    cognitive:    z.number(),
  }),
  effectivenessScore01: z.number().min(0).max(1),
  classification: z.enum(["EFFECTIVE", "NEUTRAL", "INEFFECTIVE", "COUNTERPRODUCTIVE"]),
  neutralLanguage: z.string(),
});
export type RecoveryEffectiveness = z.infer<typeof RecoveryEffectivenessSchema>;

export function measureRecoveryEffectiveness(input: {
  eventKind: RecoveryEventKind;
  preMetrics:  { behaviorRiskScore01: number; disciplineScore01: number; cognitiveRisk01: number };
  postMetrics: { behaviorRiskScore01: number; disciplineScore01: number; cognitiveRisk01: number };
}): RecoveryEffectiveness {
  const dB = input.preMetrics.behaviorRiskScore01 - input.postMetrics.behaviorRiskScore01;  // ↓ good
  const dD = input.postMetrics.disciplineScore01  - input.preMetrics.disciplineScore01;    // ↑ good
  const dC = input.preMetrics.cognitiveRisk01     - input.postMetrics.cognitiveRisk01;     // ↓ good
  // Each Δ in [-1..+1]; normalize → [0..1] effectiveness via average then squash.
  const composite = (dB * 0.4 + dD * 0.4 + dC * 0.2);
  const effectiveness = clamp01(0.5 + composite);  // 0.5 = no change
  let classification: RecoveryEffectiveness["classification"];
  if (composite >= 0.20)      classification = "EFFECTIVE";
  else if (composite >= 0.05) classification = "NEUTRAL";
  else if (composite >= -0.10) classification = "INEFFECTIVE";
  else classification = "COUNTERPRODUCTIVE";
  return {
    eventKind: input.eventKind,
    preMetrics: input.preMetrics, postMetrics: input.postMetrics,
    improvementDeltas: { behaviorRisk: round2(dB), discipline: round2(dD), cognitive: round2(dC) },
    effectivenessScore01: round2(effectiveness),
    classification,
    neutralLanguage: `${input.eventKind} effectiveness ${effectiveness.toFixed(2)} (${classification}); ΔbehaviorRisk=${dB.toFixed(2)}, Δdiscipline=${dD.toFixed(2)}, Δcognitive=${dC.toFixed(2)}.`,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
