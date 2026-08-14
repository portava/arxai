import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral Stress Contribution — does this strategy push OTHER strategies
// to misbehave? Cascading position closes, herding, fear contagion. Higher
// = bad. Returned in [0, 1].
// ═══════════════════════════════════════════════════════════════════════════

export const BehStressInputsSchema = z.object({
  strategyId: z.string().min(1),
  observedHerdingScore01: z.number().min(0).max(1),
  cascadeTriggerEvents: z.int().nonnegative(),
  observationWindowHours: z.number().positive(),
  panicAmplificationScore01: z.number().min(0).max(1),
});
export type BehStressInputs = z.infer<typeof BehStressInputsSchema>;

export interface BehStressContribution {
  strategyId: string;
  stress01: number;
  triggers: string[];
}

export function evaluateBehavioralStressContribution(
  i: BehStressInputs,
): BehStressContribution {
  const triggers: string[] = [];
  if (i.observedHerdingScore01 > 0.6) triggers.push(`herding ${i.observedHerdingScore01.toFixed(2)}`);
  // Cascade rate normalised per 24h.
  const cascadePerDay = (i.cascadeTriggerEvents / i.observationWindowHours) * 24;
  const cascadeNorm = Math.min(1, cascadePerDay / 5);
  if (cascadePerDay >= 2) triggers.push(`cascades/day ${cascadePerDay.toFixed(2)}`);
  if (i.panicAmplificationScore01 > 0.5) triggers.push(`panic amplification ${i.panicAmplificationScore01.toFixed(2)}`);
  const stress01 = Math.min(1,
    i.observedHerdingScore01 * 0.35
    + cascadeNorm * 0.35
    + i.panicAmplificationScore01 * 0.30,
  );
  return { strategyId: i.strategyId, stress01, triggers };
}
