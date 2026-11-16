import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Overfit Mutation Detector — does the mutation perform spectacularly on
// the training fold and badly elsewhere? Inputs are per-fold expectancies.
// Returns overfit01 in [0,1]. >= 0.6 ⇒ recommend block.
// ═══════════════════════════════════════════════════════════════════════════

export const OverfitInputsSchema = z.object({
  variantId: z.string().min(1),
  parameterCount: z.int().positive(),
  trainExpectancyR: z.number(),
  validationExpectancyRPerFold: z.array(z.number()).min(2),
});
export type OverfitInputs = z.infer<typeof OverfitInputsSchema>;

export interface OverfitResult {
  variantId: string;
  overfit01: number;
  block: boolean;
  triggers: string[];
  reasons: string[];
}

export function detectOverfit(i: OverfitInputs): OverfitResult {
  const triggers: string[] = [];
  const meanVal = i.validationExpectancyRPerFold.reduce((s, x) => s + x, 0) / i.validationExpectancyRPerFold.length;
  const variance =
    i.validationExpectancyRPerFold.reduce((s, x) => s + (x - meanVal) ** 2, 0) /
    i.validationExpectancyRPerFold.length;
  const stdev = Math.sqrt(variance);
  let s = 0;
  // Train >> val gap
  const gap = i.trainExpectancyR - meanVal;
  if (gap > 0.2) {
    s += 0.40;
    triggers.push(`train ${i.trainExpectancyR.toFixed(3)} >> mean val ${meanVal.toFixed(3)} (gap ${gap.toFixed(3)})`);
  }
  // High variance across folds
  if (stdev > 0.25) {
    s += 0.30;
    triggers.push(`fold stdev ${stdev.toFixed(3)} > 0.25`);
  }
  // Too many parameters relative to folds
  if (i.parameterCount > i.validationExpectancyRPerFold.length * 4) {
    s += 0.20;
    triggers.push(`${i.parameterCount} params for ${i.validationExpectancyRPerFold.length} folds`);
  }
  // At least one fold strongly negative
  const minFold = Math.min(...i.validationExpectancyRPerFold);
  if (minFold < -0.1) {
    s += 0.10;
    triggers.push(`worst fold expectancy ${minFold.toFixed(3)} < -0.1`);
  }
  const overfit01 = Math.min(1, s);
  const block = overfit01 >= 0.6;
  return {
    variantId: i.variantId,
    overfit01,
    block,
    triggers,
    reasons: [`overfit=${overfit01.toFixed(3)} from ${triggers.length} trigger(s); block=${block}`],
  };
}
