// Cognitive State — Phase 5 alias barrel for cognitive.types.
//
// Re-exports the existing cognitive types under the spec-mandated filename
// (cognitiveState.types.ts) plus adds the composed CognitiveRiskScore type
// the Risk Governor consumes.
import { z } from "zod/v4";
import { DnaSeveritySchema } from "../trader-dna/traderProfile.types";

export * from "./cognitive.types";

export const CognitiveRiskScoreSchema = z.object({
  score01: z.number().min(0).max(1),
  level:   DnaSeveritySchema,
  components: z.object({
    load01:        z.number().min(0).max(1),
    stress01:      z.number().min(0).max(1),
    fatigue01:     z.number().min(0).max(1),
    degradation01: z.number().min(0).max(1),
  }),
  reasons: z.array(z.string()),
});
export type CognitiveRiskScore = z.infer<typeof CognitiveRiskScoreSchema>;

export function composeCognitiveRiskScore(input: {
  load01: number; stress01: number; fatigue01: number; degradation01: number;
  acuteSpike?: boolean; revengeRiskFlag?: boolean;
}): CognitiveRiskScore {
  const reasons: string[] = [];
  // Cognitive risk is a max-aware weighted blend — the worst component pulls
  // the score up so a single critical signal isn't averaged out.
  const weighted = 0.20 * input.load01 + 0.30 * input.stress01
                 + 0.25 * input.fatigue01 + 0.25 * input.degradation01;
  const worst = Math.max(input.load01, input.stress01, input.fatigue01, input.degradation01);
  let score01 = Math.max(weighted, 0.85 * worst);
  if (input.acuteSpike)      score01 = Math.max(score01, 0.85);
  if (input.revengeRiskFlag) score01 = Math.max(score01, 0.90);
  score01 = clamp01(score01);

  let level: "NONE"|"LOW"|"MEDIUM"|"HIGH"|"CRITICAL";
  if (score01 >= 0.85)      level = "CRITICAL";
  else if (score01 >= 0.65) level = "HIGH";
  else if (score01 >= 0.45) level = "MEDIUM";
  else if (score01 >= 0.25) level = "LOW";
  else                      level = "NONE";

  reasons.push(`load ${input.load01.toFixed(2)} · stress ${input.stress01.toFixed(2)} · fatigue ${input.fatigue01.toFixed(2)} · degradation ${input.degradation01.toFixed(2)} → ${score01.toFixed(2)} (${level})`);
  if (input.acuteSpike)      reasons.push(`acute stress spike — floor 0.85`);
  if (input.revengeRiskFlag) reasons.push(`revenge-trading flag — floor 0.90`);

  return {
    score01, level,
    components: {
      load01: clamp01(input.load01), stress01: clamp01(input.stress01),
      fatigue01: clamp01(input.fatigue01), degradation01: clamp01(input.degradation01),
    },
    reasons,
  };
}
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
